import { describe, expect, test } from 'vitest';
import {
  assertHostResolvesToPublicAddress,
  assertTargetEligible,
  assertRequestUrlAllowed,
  assertRedirectUrlAllowed,
  assertRedirectUrlAllowedForHost,
} from '@/fetch/host-policy';
import type { CrawlTarget } from '@/core/types';

// CRAWL-C5: this module is the SSRF / DNS-rebinding guard for
// the entire crawl stack — every fetch the crawler makes passes through it —
// so these tests lock its security behavior down directly.
//
// The DNS lookup is injectable (lookupFn), so the rebinding cases below are
// exercised against a stub, with no network — deterministic, offline,
// and able to express answers a real resolver would rarely hand back.

function makeSource(overrides: Partial<CrawlTarget> = {}): CrawlTarget {
  return {
    name: 'Test Venue',
    baseUrl: 'https://venue.example.com',
    robotsPolicy: 'allow',
    active: true,
    ...overrides,
  };
}

const lookupTo = (address: string, family = 4) => async () => [{ address, family }];

describe('assertHostResolvesToPublicAddress — DNS rebinding defence', () => {
  // The core SSRF case: a hostname that LOOKS public but resolves inward.
  // Hostnames are unique per test — the module memoizes safe hosts, so a
  // shared name would let one case's cached verdict mask another's.
  test.each([
    ['loopback', '127.0.0.1'],
    ['private 10/8', '10.0.0.5'],
    ['private 192.168/16', '192.168.1.10'],
    ['private 172.16/12', '172.20.10.4'],
    ['carrier-grade NAT 100.64/10', '100.100.0.1'],
    ['benchmarking 198.18/15', '198.18.0.1'],
    ['this-network 0/8', '0.0.0.0'],
    ['multicast/reserved 224+', '239.1.2.3'],
  ])('blocks a public hostname that resolves to %s', async (label, address) => {
    const host = `rebind-${label.replace(/[^a-z0-9]/gi, '')}.example.com`;
    await expect(assertHostResolvesToPublicAddress(host, lookupTo(address))).rejects.toThrow(/private IPv4/i);
  });

  test.each([
    // AWS/GCP/Azure instance metadata — the highest-value SSRF target there is.
    ['the cloud metadata address (169.254.169.254)', 'metadata-rebind.example.com', lookupTo('169.254.169.254'), /private IPv4/i],
    ['IPv6 loopback', 'v6-loopback.example.com', lookupTo('::1', 6), /private IPv6/i],
    ['an IPv4-mapped IPv6 answer written with dots (fails closed as an invalid address)', 'v6-mapped.example.com', lookupTo('::ffff:10.0.0.1', 6), /invalid address/i],
    // A multi-record answer where only ONE entry is internal must still be
    // rejected — checking just the first record would be exploitable.
    ['a lookup where ANY returned record is private', 'mixed-records.example.com', async () => [{ address: '93.184.216.34', family: 4 }, { address: '10.1.2.3', family: 4 }], /private IPv4/i],
    ['an empty DNS answer', 'empty-answer.example.com', async () => [], /no addresses/i],
    ['a malformed address', 'bad-answer.example.com', lookupTo('not-an-ip'), /invalid address/i],
    ['a resolver failure', 'resolver-down.example.com', async () => Promise.reject(new Error('SERVFAIL')), /DNS lookup failed/i],
  ])('blocks %s', async (_name, host, lookup, message) => {
    await expect(assertHostResolvesToPublicAddress(host, lookup)).rejects.toThrow(message);
  });

  test('allows a genuinely public address', async () => {
    await expect(
      assertHostResolvesToPublicAddress('public-ok.example.com', lookupTo('93.184.216.34')),
    ).resolves.toBeUndefined();
  });

  // The module caches SAFE hosts to avoid re-resolving. A failure must not
  // be cached, or one transient SERVFAIL would poison the host until restart.
  test('does not cache failures — a later successful lookup is honoured', async () => {
    let attempt = 0;
    const flaky = async () => {
      attempt += 1;
      if (attempt === 1) throw new Error('transient SERVFAIL');
      return [{ address: '93.184.216.34', family: 4 }];
    };
    await expect(assertHostResolvesToPublicAddress('flaky-host.example.com', flaky)).rejects.toThrow(/DNS lookup failed/i);
    await expect(assertHostResolvesToPublicAddress('flaky-host.example.com', flaky)).resolves.toBeUndefined();
    expect(attempt).toBe(2);
  });

  test.each(['localhost', '127.0.0.1', '0.0.0.0', '::1'])('blocks the literal blocked host %s before any DNS call', async (host) => {
    let called = false;
    const lookup = async () => {
      called = true;
      return [{ address: '93.184.216.34', family: 4 }];
    };
    await expect(assertHostResolvesToPublicAddress(host, lookup)).rejects.toThrow();
    expect(called).toBe(false);
  });

  test.each(['printer.local', 'db.internal', 'app.localhost', 'box.localdomain'])(
    'blocks the internal-network suffix host %s',
    async (host) => {
      await expect(assertHostResolvesToPublicAddress(host, lookupTo('93.184.216.34'))).rejects.toThrow();
    },
  );
});

describe('assertTargetEligible', () => {
  test.each<[string, Partial<CrawlTarget>, RegExp | undefined]>([
    ['an inactive source', { active: false }, /inactive/i],
    ['a disallow robots policy', { robotsPolicy: 'disallow' }, /robots/i],
    // Fail-closed: a target whose robots posture was never determined must not
    // be crawled just because nothing explicitly forbade it.
    ['an unknown robots policy (fails closed)', { robotsPolicy: 'unknown' }, /unknown robots/i],
    ['a non-https base URL', { baseUrl: 'http://venue.example.com' }, /https/i],
    ['credentials embedded in the base URL', { baseUrl: 'https://user:pass@venue.example.com' }, /[Cc]redentialed/],
    ['a base URL pointing at an internal host', { baseUrl: 'https://localhost' }, undefined],
  ])('rejects %s', (_name, overrides, message) => {
    expect(() => assertTargetEligible(makeSource(overrides))).toThrow(message);
  });

  test('accepts a well-formed public https source', () => {
    expect(() => assertTargetEligible(makeSource())).not.toThrow();
  });
});

describe('assertRequestUrlAllowed — same-site enforcement', () => {
  const source = makeSource();

  test('allows a same-host path', () => {
    expect(assertRequestUrlAllowed(source, 'https://venue.example.com/events/list').pathname).toBe('/events/list');
  });

  // OFFDOMAIN-WWW-1: a source registered at the apex must be able to crawl
  // its own www pages (and vice versa) — the most common in-page link shape.
  test('allows the apex/www counterpart of the registered host', () => {
    expect(() => assertRequestUrlAllowed(source, 'https://www.venue.example.com/events')).not.toThrow();
    const wwwSource = makeSource({ baseUrl: 'https://www.venue.example.com' });
    expect(() => assertRequestUrlAllowed(wwwSource, 'https://venue.example.com/events')).not.toThrow();
  });

  test.each([
    ['a genuinely different host', 'https://evil.example.net/events', /off-domain/i],
    // A subdomain is a different site — this is the shape an attacker gets
    // from a page that links its own CDN/user-content host.
    ['an unrelated subdomain of the same registrable domain', 'https://uploads.venue.example.com/x', /off-domain/i],
    ['a host that merely has the base host as a suffix', 'https://notvenue.example.com/events', /off-domain/i],
    ['non-https', 'http://venue.example.com/events', /non-https/i],
    ['credentialed URLs', 'https://u:p@venue.example.com/e', /[Cc]redentialed/],
    ['a cross-port URL on the same host', 'https://venue.example.com:8443/events', /cross-port/i],
    ['an unparseable URL', 'not a url', /Invalid crawl URL/i],
  ])('blocks %s', (_name, url, message) => {
    expect(() => assertRequestUrlAllowed(source, url)).toThrow(message);
  });
});

describe('assertRedirectUrlAllowed / ForHost — redirect following', () => {
  const source = makeSource();

  test('follows the apex/www redirect', () => {
    expect(() => assertRedirectUrlAllowed(source, 'https://www.venue.example.com/events/')).not.toThrow();
  });

  test.each([
    ['a redirect to another host', 'https://tracker.example.net/r?u=1', /off-domain/i],
    ['an https-to-http downgrade redirect', 'http://venue.example.com/events', /non-https/i],
    ['a redirect to an internal host', 'https://localhost/admin', undefined],
  ])('refuses %s', (_name, url, message) => {
    expect(() => assertRedirectUrlAllowed(source, url)).toThrow(message);
  });

  // The URL-only variant used where no source record exists.
  test('ForHost enforces the same rules without a source record', () => {
    expect(() => assertRedirectUrlAllowedForHost('venue.example.com', '', 'https://www.venue.example.com/x')).not.toThrow();
    expect(() => assertRedirectUrlAllowedForHost('venue.example.com', '', 'https://evil.example.net/x')).toThrow(/off-domain/i);
    expect(() => assertRedirectUrlAllowedForHost('venue.example.com', '', 'https://venue.example.com:9000/x')).toThrow(/cross-port/i);
    expect(() => assertRedirectUrlAllowedForHost('venue.example.com', '', 'https://169.254.169.254/latest/meta-data/')).toThrow();
  });
});

// HOST-CACHE-SCOPE-1 (seen in live validation): the safe-host cache was a
// single module-level Map, so a host validated by ONE crawler was trusted by
// every other crawler in the process — including one deliberately configured
// with a different resolver. A resolver is part of a crawler's security
// configuration; its verdicts must not leak across differently-configured
// instances.
describe('DNS safe-cache is scoped per resolver', () => {
  test('a host cleared by one resolver is distrusted by another', async () => {
    const permissive = async () => [{ address: '93.184.216.34', family: 4 }];
    const restrictive = async () => [{ address: '127.0.0.1', family: 4 }];

    // First resolver says the host is public — cached under ITS namespace.
    await expect(assertHostResolvesToPublicAddress('shared-host.example.com', permissive)).resolves.toBeUndefined();

    // A different resolver must still get its own verdict.
    await expect(assertHostResolvesToPublicAddress('shared-host.example.com', restrictive)).rejects.toThrow(
      /private IPv4/i,
    );
  });

  test('the same resolver still caches (one lookup)', async () => {
    let lookups = 0;
    const counting = async () => {
      lookups++;
      return [{ address: '93.184.216.34', family: 4 }];
    };

    await assertHostResolvesToPublicAddress('cached-host.example.com', counting);
    await assertHostResolvesToPublicAddress('cached-host.example.com', counting);
    expect(lookups).toBe(1);
  });
});
