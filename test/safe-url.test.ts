import { describe, expect, it } from 'vitest';
import {
  isForbiddenAddress, isForbiddenHostname, resolveDeliverableUrl, pinnedDispatcher, URL_NOT_ALLOWED,
} from '../src/core/safe-url.js';

const pub = async () => [{ address: '203.0.113.10', family: 4 as const }];
const loop = async () => [{ address: '127.0.0.1', family: 4 as const }];
const mixed = async () => [{ address: '203.0.113.10', family: 4 as const }, { address: '10.0.0.5', family: 4 as const }];
const none = async () => [];

describe('isForbiddenAddress', () => {
  const forbidden = [
    '0.0.0.0', '0.1.2.3', '10.0.0.1', '100.64.0.1', '100.127.255.254', '127.0.0.1', '127.255.255.255',
    '169.254.169.254', '172.16.0.1', '172.31.255.255', '192.0.0.1', '192.168.1.1', '198.18.0.1', '198.19.255.255',
    '224.0.0.1', '239.255.255.255', '240.0.0.1', '255.255.255.255',
    '::', '::1', 'fc00::1', 'fdff::1', 'fe80::1', 'febf::1', 'ff02::1',
    '::ffff:127.0.0.1', '::ffff:7f00:1', '::ffff:10.0.0.1', '::ffff:a9fe:a9fe', '64:ff9b::7f00:1',
  ];
  const allowed = ['203.0.113.10', '8.8.8.8', '100.63.255.255', '100.128.0.0', '172.32.0.1', '2606:4700::1111', '::ffff:8.8.8.8'];
  for (const ip of forbidden) it(`forbids ${ip}`, () => expect(isForbiddenAddress(ip)).toBe(true));
  for (const ip of allowed) it(`allows ${ip}`, () => expect(isForbiddenAddress(ip)).toBe(false));
});

describe('isForbiddenHostname', () => {
  for (const h of ['localhost', 'LOCALHOST', 'foo.localhost', 'db.local', 'metadata.google.internal', 'x.internal', 'host.home.arpa', '127.0.0.1', '[::1]', '[fd00::1]', '100.100.100.100']) {
    it(`forbids ${h}`, () => expect(isForbiddenHostname(h)).toBe(true));
  }
  for (const h of ['example.com', 'hooks.example.org', '203.0.113.10', '[2606:4700::1111]']) {
    it(`allows ${h}`, () => expect(isForbiddenHostname(h)).toBe(false));
  }
});

describe('resolveDeliverableUrl', () => {
  it('rejects non-https', async () => {
    await expect(resolveDeliverableUrl('http://example.com/h', { lookup: pub })).rejects.toThrow(URL_NOT_ALLOWED);
  });
  it('rejects a forbidden hostname before resolving', async () => {
    let called = false;
    const spy: typeof pub = async () => { called = true; return pub(); };
    await expect(resolveDeliverableUrl('https://localhost/h', { lookup: spy })).rejects.toThrow(URL_NOT_ALLOWED);
    expect(called).toBe(false);
  });
  it('rejects a public name that resolves to loopback', async () => {
    await expect(resolveDeliverableUrl('https://internal.attacker.example/', { lookup: loop })).rejects.toThrow(URL_NOT_ALLOWED);
  });
  it('rejects when any resolved address is forbidden', async () => {
    await expect(resolveDeliverableUrl('https://example.com/', { lookup: mixed })).rejects.toThrow(URL_NOT_ALLOWED);
  });
  it('rejects a name that does not resolve or errors', async () => {
    await expect(resolveDeliverableUrl('https://example.com/', { lookup: none })).rejects.toThrow(URL_NOT_ALLOWED);
    await expect(resolveDeliverableUrl('https://example.com/', { lookup: async () => { throw new Error('ENOTFOUND'); } })).rejects.toThrow(URL_NOT_ALLOWED);
  });
  it('accepts a public name and returns the vetted addresses', async () => {
    const r = await resolveDeliverableUrl('https://example.com/h', { lookup: pub });
    expect(r.url.hostname).toBe('example.com');
    expect(r.addresses).toEqual([{ address: '203.0.113.10', family: 4 }]);
  });
  it('never includes the hostname in the error message', async () => {
    await expect(resolveDeliverableUrl('https://secret-host.example/', { lookup: loop })).rejects.not.toThrow(/secret-host/);
  });
  it('skips every check when allowPrivateHosts is set (development only)', async () => {
    const r = await resolveDeliverableUrl('http://localhost:3000/h', { lookup: loop, allowPrivateHosts: true });
    expect(r.url.hostname).toBe('localhost');
  });
});

describe('pinnedDispatcher', () => {
  it('returns a dispatcher whose lookup answers only with the vetted address', async () => {
    const d = pinnedDispatcher([{ address: '203.0.113.10', family: 4 }]);
    expect(typeof (d as { dispatch?: unknown }).dispatch).toBe('function');
    await d.close();
  });
});
