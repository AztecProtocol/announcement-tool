#!/usr/bin/env python3
r"""Offline check for the announce-postgres failregex.

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

A newline inside a client-supplied value (a user name, found in review on
2026-10-08) makes Postgres write a CONTINUATION line that begins with a TAB
and repeats the message with a forged address. fail2ban finds no timestamp on
that line. The filter's single leading space (not `^\s*`) refuses the TAB, and
the mirror (pg-auth-log.sh.j2) drops the line before fail2ban sees it. Both
layers are modelled: FAILREGEXES is the filter, MIRROR is the mirror grep, and
the TAB cases below are checked against both.

Every case in CASES was also run through the real `fail2ban-regex` of fail2ban
1.0.2 with the same result (2026-10-08). If the two ever disagree, fail2ban is
right and this file is wrong.

Exit 0 only when every failure line yields the REAL client address and every
other line yields none.
"""
import re, sys

# One pattern per line, exactly as the filter's `failregex` lists them.
# EXACTLY ONE leading space, not `^\s*`: the space is what fail2ban leaves
# after it strips the timestamp, and `\s*` would also swallow the leading
# TAB of a continuation line a caller can forge with a newline in a value
# (see the 'tab-continuation' case below).
FAILREGEXES = [
    r'^ \[\d+\] <HOST> FATAL:  password authentication failed for user "',
    r'^ \[\d+\] <HOST> FATAL:  no pg_hba\.conf entry for',
]
# The mirror layer (pg-auth-log.sh.j2) runs BEFORE fail2ban and keeps only
# lines that start as a real Postgres log line. A line the mirror drops
# never reaches the filter at all. This is that same grep, so a case can be
# checked against the mirror as well as the filter.
MIRROR = re.compile(r'^[0-9]{4}-[0-9]{2}-[0-9]{2} [0-9:.]+ UTC \[[0-9]+\] [^ ]+ FATAL:  ')
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
    # THE NEWLINE CASE (found in review 2026-10-08). A user name holding a
    # newline makes Postgres write a CONTINUATION line that begins with a
    # TAB and repeats the message with the forged address. fail2ban finds no
    # timestamp on it. The old `^\s*` matched the leading TAB and banned the
    # forged address; the single-space anchor does not. The mirror drops it
    # too (no real timestamp at the start), so it is rejected by BOTH layers.
    'tab-continuation': (
        f'\t[1] {FORGED} FATAL:  no pg_hba.conf entry for"',
        None),
    # The same, carrying a FORGED FULL TIMESTAMP after the newline: the
    # continuation line is `\t<forged ts> [1] <forged ip> FATAL:  ..`. The
    # TAB is still first, so neither layer is fooled — the filter needs the
    # line to START with one space then `[pid]`, and the mirror needs it to
    # START with a real timestamp (this one starts with a TAB).
    'tab-forged-timestamp': (
        f'\t{TS} [1] {FORGED} FATAL:  password authentication failed for user "x',
        None),
    # A bare carriage return in the user name does NOT start a new log line
    # (Postgres only breaks on a newline). The forged text stays inline,
    # inside the quoted user name, AFTER the real host. The real peer is
    # reported, never the forged address. Confirmed against real
    # postgres:16-alpine + fail2ban-regex 1.0.2.
    'cr-inline': (
        f'{TS} [1] {REAL} FATAL:  password authentication failed for user "\r[1] {FORGED} FATAL:  password authentication failed for user x"',
        REAL),
}
ok = True
for name, (line, expect) in CASES.items():
    host = host_of(line)
    if name == 'socket':
        good = host in (None, '[local]')
    else:
        good = host == expect
    # The mirror is the first layer. A case that forges an address through a
    # continuation line (TAB-led) must be dropped by the mirror too, not only
    # by the filter: check the raw line against the mirror grep for those.
    mirror_kept = bool(MIRROR.match(line))
    mnote = ''
    if name in ('tab-continuation', 'tab-forged-timestamp', 'compose-prefix'):
        # These must be dropped by the mirror (MIRROR must not match).
        if mirror_kept:
            good = False
            mnote = ' MIRROR-KEPT-WRONG'
        else:
            mnote = ' mirror-drops-ok'
    print(f'{name:19s} -> {host!r:20} {"ok" if good else "WRONG"}{mnote}')
    ok = ok and good
sys.exit(0 if ok else 1)
