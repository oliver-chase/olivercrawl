import { describe, expect, test } from 'vitest';
import { createCrawler } from '@/index';
import { crawlSite } from '@/crawl-site';
import type { CrawlTarget } from '@/core/types';
import { linkedDoc as html, publicDns } from '../helpers';

// CRAWL-HOST-STATS-1: a run reports how its host behaved, and usage events name the host.

const target: CrawlTarget = { baseUrl: 'https://stats.example.com', robotsPolicy: 'allow', active: true };

function web() {
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = new URL(String(input));
    if (url.pathname === '/robots.txt') return new Response('', { status: 404 });
    if (url.pathname === '/') return new Response(html(['/ok', '/gone', '/walled']), { headers: { 'content-type': 'text/html' } });
    if (url.pathname === '/gone') return new Response('missing', { status: 404 });
    if (url.pathname === '/walled') return new Response('no', { status: 403 });
    return new Response(html([]), { headers: { 'content-type': 'text/html' } });
  }) as typeof fetch;
}

describe('per-host stats', () => {
  test('counts pages, failure classes and the block rate for the host', async () => {
    web();
    const run = await crawlSite(createCrawler({ userAgent: 'T/1 (+https://t.example/bot)', dnsLookup: publicDns }), target, {
      followLinks: true,
      maxDepth: 1,
      maxPages: 10,
      maxRetries: 0,
    });
    const stats = run.hosts['stats.example.com']!;
    expect(stats.pages).toBe(2);
    expect(stats.attempts).toBe(4);
    expect(stats.failures.structural).toBeGreaterThanOrEqual(1);
    expect(stats.blockRate).toBeGreaterThan(0);
    expect(stats.blockRate).toBeLessThanOrEqual(0.5);
    expect(stats.medianLatencyMs).toBeGreaterThanOrEqual(0);
  });
});
