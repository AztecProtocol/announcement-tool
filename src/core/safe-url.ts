/**
 * Destination policy for outbound webhook requests.
 *
 * The public subscribe form lets an anonymous person register any URL, and
 * the tool then POSTs to it from Netlify's egress. Two things make that safe:
 *
 *   1. The name is RESOLVED before the decision, and every address it
 *      resolves to is checked against the forbidden ranges below. A hostname
 *      regex alone is not a control: an attacker-owned name can point at
 *      127.0.0.1, at the tailnet, or at a cloud metadata address.
 *   2. The connection is PINNED to the address that passed. `fetch` would
 *      otherwise resolve the name a second time at connect, and a DNS
 *      answer that changes between the two lookups (rebinding) would defeat
 *      the check. The dispatcher returned here answers connect-time lookups
 *      with the vetted address only.
 *
 * Every refusal throws URL_NOT_ALLOWED with no detail: the message reaches
 * an anonymous caller, and the hostname or address would turn it into a probe.
 */
import { isIP, type LookupFunction } from 'node:net';
import type { LookupAddress } from 'node:dns';
import { lookup as dnsLookup } from 'node:dns/promises';
import { Agent, type Dispatcher } from 'undici';

export const URL_NOT_ALLOWED = 'webhook url not allowed';

export type LookupFn = (hostname: string) => Promise<Array<{ address: string; family: 4 | 6 }>>;

const FORBIDDEN_V4: Array<[number, number]> = [
  // [network, prefix length]
  [0x00000000, 8],   // 0.0.0.0/8 "this" network
  [0x0a000000, 8],   // 10/8
  [0x64400000, 10],  // 100.64/10 carrier-grade NAT, also the Tailscale range
  [0x7f000000, 8],   // 127/8 loopback
  [0xa9fe0000, 16],  // 169.254/16 link-local and cloud metadata
  [0xac100000, 12],  // 172.16/12
  [0xc0000000, 24],  // 192.0.0/24 IETF protocol assignments
  [0xc0a80000, 16],  // 192.168/16
  [0xc6120000, 15],  // 198.18/15 benchmarking
  [0xe0000000, 4],   // 224/4 multicast
  [0xf0000000, 4],   // 240/4 reserved, includes 255.255.255.255
];

function v4ToInt(ip: string): number {
  const p = ip.split('.').map(Number);
  return ((p[0] << 24) | (p[1] << 16) | (p[2] << 8) | p[3]) >>> 0;
}

function forbiddenV4(ip: string): boolean {
  const n = v4ToInt(ip);
  return FORBIDDEN_V4.some(([net, bits]) => {
    const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
    return ((n & mask) >>> 0) === net;
  });
}

/** Expand an IPv6 textual address to eight 16-bit groups. Returns undefined on junk. */
function v6Groups(ip: string): number[] | undefined {
  let s = ip;
  // Embedded dotted-quad tail (::ffff:1.2.3.4, 64:ff9b::1.2.3.4) -> two hex groups.
  const dq = /^(.*:)(\d+\.\d+\.\d+\.\d+)$/.exec(s);
  if (dq) {
    const n = v4ToInt(dq[2]);
    s = `${dq[1]}${(n >>> 16).toString(16)}:${(n & 0xffff).toString(16)}`;
  }
  const halves = s.split('::');
  if (halves.length > 2) return undefined;
  const head = halves[0] ? halves[0].split(':') : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  const fill = halves.length === 2 ? 8 - head.length - tail.length : 0;
  if (fill < 0 || (halves.length === 1 && head.length !== 8)) return undefined;
  const groups = [...head, ...Array<string>(fill).fill('0'), ...tail].map(g => parseInt(g, 16));
  return groups.length === 8 && groups.every(g => Number.isInteger(g) && g >= 0 && g <= 0xffff) ? groups : undefined;
}

function forbiddenV6(ip: string): boolean {
  const g = v6Groups(ip);
  if (!g) return true; // unparseable is not deliverable
  const isZero = (from: number, to: number) => g.slice(from, to).every(x => x === 0);
  if (isZero(0, 8)) return true;                                   // ::
  if (isZero(0, 7) && g[7] === 1) return true;                     // ::1
  if (isZero(0, 5) && g[5] === 0xffff) {                           // ::ffff:a.b.c.d  IPv4-mapped
    return forbiddenV4(`${g[6] >> 8}.${g[6] & 0xff}.${g[7] >> 8}.${g[7] & 0xff}`);
  }
  if (isZero(0, 6) && !(g[6] === 0 && g[7] === 0)) {               // ::a.b.c.d  IPv4-compatible (deprecated)
    return forbiddenV4(`${g[6] >> 8}.${g[6] & 0xff}.${g[7] >> 8}.${g[7] & 0xff}`);
  }
  if (g[0] === 0x64 && g[1] === 0xff9b && isZero(2, 6)) {          // 64:ff9b::/96  NAT64
    return forbiddenV4(`${g[6] >> 8}.${g[6] & 0xff}.${g[7] >> 8}.${g[7] & 0xff}`);
  }
  if (g[0] === 0x64 && g[1] === 0xff9b && g[2] === 1) return true; // 64:ff9b:1::/48 local-use NAT64
  if (g[0] === 0x2002) {                                           // 2002::/16 6to4, v4 in groups 1-2
    return forbiddenV4(`${g[1] >> 8}.${g[1] & 0xff}.${g[2] >> 8}.${g[2] & 0xff}`);
  }
  if ((g[0] & 0xffc0) === 0xfec0) return true;                     // fec0::/10 site-local (deprecated)
  if ((g[0] & 0xfe00) === 0xfc00) return true;                     // fc00::/7 unique local
  if ((g[0] & 0xffc0) === 0xfe80) return true;                     // fe80::/10 link-local
  if ((g[0] & 0xff00) === 0xff00) return true;                     // ff00::/8 multicast
  return false;
}

export function isForbiddenAddress(ip: string): boolean {
  const kind = isIP(ip);
  if (kind === 4) return forbiddenV4(ip);
  if (kind === 6) return forbiddenV6(ip);
  return true;
}

const FORBIDDEN_NAME = /(^|\.)(localhost|local|internal|home\.arpa|localdomain)$/i;

/** Hostname as produced by the URL parser: lowercase, brackets kept on IPv6 literals. */
export function isForbiddenHostname(hostname: string): boolean {
  // A trailing root dot is the same name to the resolver ("localhost." resolves
  // to localhost), so strip one before either check or it bypasses the list.
  const name = hostname.endsWith('.') ? hostname.slice(0, -1) : hostname;
  const bare = name.startsWith('[') && name.endsWith(']') ? name.slice(1, -1) : name;
  if (isIP(bare)) return isForbiddenAddress(bare);
  return FORBIDDEN_NAME.test(name);
}

const defaultLookup: LookupFn = async hostname =>
  (await dnsLookup(hostname, { all: true, verbatim: true })).map(r => ({ address: r.address, family: r.family as 4 | 6 }));

export async function resolveDeliverableUrl(
  url: string,
  opts: { lookup?: LookupFn; allowPrivateHosts?: boolean } = {},
): Promise<{ url: URL; addresses: Array<{ address: string; family: 4 | 6 }> }> {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    throw new Error(URL_NOT_ALLOWED);
  }
  if (opts.allowPrivateHosts) {
    // Test-only escape hatch, meaning "talk to a local test server over http".
    // It is a function argument with no environment mapping, so nothing in a
    // deployed instance can turn it on, and both production call sites (the
    // webhook adapter and the registration flow) omit it.
    return { url: u, addresses: [] };
  }
  if (u.protocol !== 'https:') throw new Error(URL_NOT_ALLOWED);
  if (isForbiddenHostname(u.hostname)) throw new Error(URL_NOT_ALLOWED);

  let addresses: Array<{ address: string; family: 4 | 6 }>;
  try {
    addresses = await (opts.lookup ?? defaultLookup)(u.hostname);
  } catch {
    throw new Error(URL_NOT_ALLOWED);
  }
  if (addresses.length === 0 || addresses.some(a => isForbiddenAddress(a.address))) {
    throw new Error(URL_NOT_ALLOWED);
  }
  return { url: u, addresses };
}

/**
 * A dispatcher whose connect-time lookup returns only the vetted address, so
 * the name cannot be re-resolved to something else after the check. TLS still
 * verifies the certificate against the hostname (servername is the URL host,
 * not the address).
 */
export function pinnedDispatcher(addresses: Array<{ address: string; family: 4 | 6 }>): Dispatcher {
  // The callback MUST use the array form. Node enables autoSelectFamily by
  // default, so net/tls call a custom lookup with { all: true } and reject the
  // three-argument (address, family) form with "Invalid IP address: undefined".
  // Both forms satisfy LookupFunction's union-typed callback, so only a test
  // that really dispatches catches this.
  const vetted: LookupAddress[] = addresses.map(a => ({ address: a.address, family: a.family }));
  const lookup: LookupFunction = (_hostname, _opts, cb) => { cb(null, vetted); };
  return new Agent({ connect: { lookup } });
}
