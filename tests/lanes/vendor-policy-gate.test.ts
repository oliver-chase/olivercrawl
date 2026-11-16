import { describe, expect, test } from 'vitest';
import { createCrawler } from '@/index';
import type { CrawlTarget } from '@/core/types';

// VENDOR-POLICY-1: governance belongs to the crawl, whichever network makes
// the request, so `lanes: ['vendor']` never pays a vendor to fetch what the own
// lane would refuse.

function vendorStub() {
  const calls: string[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    calls.push(url);
    if (url.includes('api.firecrawl.dev')) {
      return new Response(JSON.stringify({ data: { markdown: 'Paid content from the vendor.' } }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    if (url.endsWith('/robots.txt')) return new Response('User-agent: *\nAllow: /', { status: 200 });
    return new Response('should not be fetched directly', { status: 500 });
  }) as typeof fetch;
  return calls;
}

const crawler = () =>
  createCrawler({
    userAgent: 'T/1',
    dnsLookup: async () => [{ address: '93.184.216.34', family: 4 }],
    vendor: { firecrawl: 'fc-key-long-enough' },
  });

describe('vendor-only crawls are still governed', () => {
  test.each<[string, CrawlTarget, string]>([
    ['an off-domain URL is blocked before any vendor is paid', { baseUrl: 'https://venue.example.com', robotsPolicy: 'allow', active: true }, 'https://evil.example.net/page'],
    ['unknown robots posture fails closed even with a paid key', { baseUrl: 'https://venue.example.com', active: true }, 'https://venue.example.com/events'],
    ['an inactive target is refused for the vendor lane too', { baseUrl: 'https://venue.example.com', robotsPolicy: 'allow', active: false }, 'https://venue.example.com/events'],
  ])('%s', async (_name, target, url) => {
    const calls = vendorStub();

    const result = await crawler().crawl(target, url, { lanes: ['vendor'] });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected blocked');
    expect(result.reason).toBe('blocked');
    expect(calls.some((u) => u.includes('firecrawl'))).toBe(false);
  });

  test('a vetted same-site URL still reaches the vendor normally', async () => {
    const calls = vendorStub();
    const target: CrawlTarget = { baseUrl: 'https://venue.example.com', robotsPolicy: 'allow', active: true };

    const result = await crawler().crawl(target, 'https://venue.example.com/events', { lanes: ['vendor'] });

    expect(result.ok).toBe(true);
    if (!result.ok || result.notModified) throw new Error('expected pages');
    expect(result.pages[0]!.lane).toBe('vendor');
    expect(calls.some((u) => u.includes('firecrawl'))).toBe(true);
  });

  test('autoRobots resolves an unknown posture before the vendor runs', async () => {
    const calls = vendorStub();
    const auto = createCrawler({
      userAgent: 'T/1',
      dnsLookup: async () => [{ address: '93.184.216.34', family: 4 }],
      autoRobots: true,
      vendor: { firecrawl: 'fc-key-long-enough' },
    });
    const target: CrawlTarget = { baseUrl: 'https://venue.example.com', active: true };

    const result = await auto.crawl(target, 'https://venue.example.com/events', { lanes: ['vendor'] });

    expect(result.ok).toBe(true);
    // robots.txt really was consulted, then the vendor ran.
    expect(calls.some((u) => u.endsWith('/robots.txt'))).toBe(true);
    expect(calls.some((u) => u.includes('firecrawl'))).toBe(true);
  });
});
