#!/usr/bin/env python3
"""Offline check for the announce-postgres failregex.

fail2ban expands <HOST> to a host-or-IP group. This script APPROXIMATES the
<HOST> expansion of fail2ban 1.0 — the version `apt` installs on Ubuntu 24.04,
which is what roles/fail2ban/tasks/main.yml pins by installing the distro
package with no version constraint. Since 0.10, <HOST> is an alternation that
matches IPv4 addresses, hostnames AND bare (unbracketed) IPv6 addresses; the
older single-group form matched only the first two, which would have made a
Postgres line logging an IPv6 %h go uncounted. The approximation below is good
enough to prove the anchoring property this script exists to test — it is not a
byte-for-byte copy of fail2ban's own definition.

It runs the regex against five lines: a benign IPv4 failure, a failure whose
USERNAME contains a forged prefix (the log-injection case), a Unix-socket line,
a bare-IPv6 failure, and an IPv6 failure with a hostile username. Exit 0 only
when every failure line yields the REAL client address and the socket line
does not bind a host.
"""
import re, sys

FAILREGEX = r'^\S+ \S+ \S+ \[\d+\] <HOST> FATAL:\s'
# Approximates fail2ban 1.0's <HOST>: IPv4/hostname first, then bare IPv6.
# Two named groups because Python's re forbids reusing one name in an
# alternation; whichever participates is the matched host.
HOST = r'(?:(?:::f{4,6}:)?(?P<host>[\w\-.^_]*\w)|(?P<host6>[0-9a-fA-F:]+))'
rx = re.compile(FAILREGEX.replace('<HOST>', HOST))

REAL = '172.17.0.1'
REAL6 = '2606:4700::1111'
FORGED = '198.51.100.77'
FORGED6 = '2001:db8::dead'
# name -> (log line, the address that must be reported, or None for "no host")
CASES = {
    'benign': (
        f'2026-09-07 11:30:36.979 UTC [69] {REAL} FATAL:  password authentication failed for user "announce"',
        REAL),
    'forged': (
        f'2026-09-07 11:30:36.979 UTC [69] {REAL} FATAL:  password authentication failed for user "a [999] {FORGED} FATAL: "',
        REAL),
    'socket': (
        '2026-09-07 11:30:36.979 UTC [70] [local] FATAL:  password authentication failed for user "announce"',
        None),
    # An IPv6 client. Postgres writes %h unbracketed, so the pattern has to
    # match a bare IPv6 address or the ban never fires for these callers.
    'ipv6': (
        f'2026-09-07 11:30:36.979 UTC [71] {REAL6} FATAL:  password authentication failed for user "announce"',
        REAL6),
    # The log-injection case again, over IPv6: the forged address embedded in
    # the username must not win over the real peer in the fourth field.
    'ipv6-forged': (
        f'2026-09-07 11:30:36.979 UTC [71] {REAL6} FATAL:  password authentication failed for user "a [999] {FORGED6} FATAL: "',
        REAL6),
}
ok = True
for name, (line, expect) in CASES.items():
    m = rx.search(line)
    host = (m.group('host') or m.group('host6')) if m else None
    good = (host == expect) if expect else (host in (None, '[local]'))
    print(f'{name:12s} -> {host!r:20} {"ok" if good else "WRONG"}')
    ok = ok and good
sys.exit(0 if ok else 1)
