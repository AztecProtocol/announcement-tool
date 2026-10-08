#!/usr/bin/env python3
"""Offline check for the announce-postgres failregex.

This script APPROXIMATES what fail2ban 1.0 does with a log line — the version
`apt` installs on Ubuntu 24.04, which is what roles/fail2ban/tasks/main.yml
pins by installing the distro package with no version constraint. It is not
fail2ban. The play itself runs the real `fail2ban-regex` against the installed
filter (tasks/verify.yml); this script is the fast check for the anchoring and
the "authentication failures only" properties, runnable anywhere.

Two things fail2ban does are modelled here:

1. It CUTS THE TIMESTAMP OUT of the line before it tries the failregex. Until
   2026-10-08 this script ran the regex over the whole line, and so passed a
   pattern (`^\\S+ \\S+ \\S+ \\[\\d+\\] <HOST> FATAL:`) that could not match one
   line in the real fail2ban: the three fields it expected at the start were
   the date, the time and the zone, which fail2ban had already removed. DATE
   below approximates the one date template that matches a Postgres `%m`
   timestamp, including the zones fail2ban takes as part of it (Z, UTC, GMT
   or a numeric offset — not a zone name such as CEST).

2. It expands <HOST> to a host-or-IP group. Since 0.10, <HOST> is an
   alternation that matches IPv4 addresses, hostnames AND bare (unbracketed)
   IPv6 addresses; the older single-group form matched only the first two,
   which would have made a Postgres line logging an IPv6 %h go uncounted.

Every case in CASES was also run through the real `fail2ban-regex` of fail2ban
1.0.2 with the same result (2026-10-08). If the two ever disagree, fail2ban is
right and this file is wrong.

Exit 0 only when every failure line yields the REAL client address and every
other line yields none.
"""
import re, sys

# One pattern per line, exactly as the filter's `failregex` lists them.
FAILREGEXES = [
    r'^\s*\[\d+\] <HOST> FATAL:\s+password authentication failed for user',
    r'^\s*\[\d+\] <HOST> FATAL:\s+no pg_hba\.conf entry for',
]
# Approximates fail2ban 1.0's <HOST>: IPv4/hostname first, then bare IPv6.
# Two named groups because Python's re forbids reusing one name in an
# alternation; whichever participates is the matched host.
HOST = r'(?:(?:::f{4,6}:)?(?P<host>[\w\-.^_]*\w)|(?P<host6>[0-9a-fA-F:]+))'
RXS = [re.compile(r.replace('<HOST>', HOST)) for r in FAILREGEXES]
# Approximates the date template that matches a Postgres %m timestamp.
DATE = re.compile(
    r'\d{4}-\d\d-\d\d \d\d:\d\d:\d\d(?:[.,]\d+)?'
    r'(?:\s*(?:Z|UTC|GMT|[+-]\d\d(?::?\d\d)?)(?![A-Za-z]))?')


def host_of(line):
    """The host fail2ban would count for this line, or None."""
    m = DATE.search(line)
    if m:
        line = line[:m.start()] + line[m.end():]
    for rx in RXS:
        m = rx.search(line)
        if m:
            return m.group('host') or m.group('host6')
    return None


REAL = '172.17.0.1'
REAL6 = '2606:4700::1111'
FORGED = '198.51.100.77'
FORGED6 = '2001:db8::dead'
PUBLIC = '203.0.113.9'
TS = '2026-09-07 11:30:36.979 UTC'
# name -> (log line, the address that must be reported, or None for "no host")
CASES = {
    'benign': (
        f'{TS} [69] {REAL} FATAL:  password authentication failed for user "announce"',
        REAL),
    'forged': (
        f'{TS} [69] {REAL} FATAL:  password authentication failed for user "a [999] {FORGED} FATAL: "',
        REAL),
    # fail2ban's own <HOST> does not bind `[local]`; the approximation above
    # may, so both "no host" and "[local]" are accepted for this one line.
    'socket': (
        f'{TS} [70] [local] FATAL:  password authentication failed for user "announce"',
        None),
    # An IPv6 client. Postgres writes %h unbracketed, so the pattern has to
    # match a bare IPv6 address or the ban never fires for these callers.
    'ipv6': (
        f'{TS} [71] {REAL6} FATAL:  password authentication failed for user "announce"',
        REAL6),
    # The log-injection case again, over IPv6: the forged address embedded in
    # the username must not win over the real peer in the field after [pid].
    'ipv6-forged': (
        f'{TS} [71] {REAL6} FATAL:  password authentication failed for user "a [999] {FORGED6} FATAL: "',
        REAL6),
    # The forged username repeats the whole message, timestamp included.
    'forged-full': (
        f'{TS} [69] {REAL} FATAL:  password authentication failed for user "{TS} [999] {FORGED} FATAL:  password authentication failed for user x"',
        REAL),
    # The second message of a refused login: pg_hba.conf has no entry for
    # this client (for example a connection without TLS).
    'pg_hba': (
        f'{TS} [72] {PUBLIC} FATAL:  no pg_hba.conf entry for host "{PUBLIC}", user "y", database "z", no encryption',
        PUBLIC),
    # FATAL lines that are NOT a failed login. Postgres writes them with the
    # client address in the same position; a database restart or a connection
    # spike produces them for the application's own addresses. Counting them
    # would ban the application.
    'too-many-clients': (
        f'{TS} [73] {PUBLIC} FATAL:  sorry, too many clients already',
        None),
    'starting-up': (
        f'{TS} [74] {PUBLIC} FATAL:  the database system is starting up',
        None),
    'shutting-down': (
        f'{TS} [74] {PUBLIC} FATAL:  the database system is shutting down',
        None),
    'admin-terminate': (
        f'{TS} [75] {PUBLIC} FATAL:  terminating connection due to administrator command',
        None),
    # A line as `docker compose logs` prints it WITHOUT --no-log-prefix. It
    # must not match: this documents that the mirror script has to strip the
    # prefix, and that the lines mirrored before 2026-10-08 are inert.
    'compose-prefix': (
        f'db-1  | {TS} [76] {PUBLIC} FATAL:  password authentication failed for user "announce_app"',
        None),
}
ok = True
for name, (line, expect) in CASES.items():
    host = host_of(line)
    if name == 'socket':
        good = host in (None, '[local]')
    else:
        good = host == expect
    print(f'{name:17s} -> {host!r:20} {"ok" if good else "WRONG"}')
    ok = ok and good
sys.exit(0 if ok else 1)
