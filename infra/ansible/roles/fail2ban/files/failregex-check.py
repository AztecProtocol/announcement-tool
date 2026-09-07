#!/usr/bin/env python3
"""Offline check for the announce-postgres failregex.

fail2ban expands <HOST> to a host-or-IP group. This script does the same
expansion and runs the regex against three lines: a benign failure, a
failure whose USERNAME contains a forged prefix (the log-injection case),
and a Unix-socket line. Exit 0 only when the benign and forged lines both
yield the REAL client address and the socket line does not match.
"""
import re, sys

FAILREGEX = r'^\S+ \S+ \S+ \[\d+\] <HOST> FATAL:\s'
HOST = r'(?P<host>[\w\-.^_]*\w|\[[0-9a-fA-F:.]+\])'  # fail2ban's default <HOST> expansion
rx = re.compile(FAILREGEX.replace('<HOST>', HOST))

REAL = '172.17.0.1'
FORGED = '198.51.100.77'
lines = {
    'benign': f'2026-09-07 11:30:36.979 UTC [69] {REAL} FATAL:  password authentication failed for user "announce"',
    'forged': f'2026-09-07 11:30:36.979 UTC [69] {REAL} FATAL:  password authentication failed for user "a [999] {FORGED} FATAL: "',
    'socket': '2026-09-07 11:30:36.979 UTC [70] [local] FATAL:  password authentication failed for user "announce"',
}
ok = True
for name, line in lines.items():
    m = rx.search(line)
    host = m.group('host') if m else None
    expect = REAL if name in ('benign', 'forged') else None
    good = (host == expect) if name != 'socket' else (host in (None, '[local]'))
    print(f'{name:7s} -> {host!r:20} {"ok" if good else "WRONG"}')
    ok = ok and good
sys.exit(0 if ok else 1)
