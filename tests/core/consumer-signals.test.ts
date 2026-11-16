import { describe, expect, test, vi } from 'vitest';
import { createCrawler } from '@/index';
import { classifyFailure } from '@/core/failure-class';
import { looksLikeEmptyState } from '@/core/soft-404';
import { EXTRACTOR_VERSION } from '@/core/types';
import { resolveConfig } from '@/core/config';
import type { CrawlTarget } from '@/core/types';
import { publicDns } from '../helpers';

const target: CrawlTarget = { baseUrl: 'https://venue.example.com', robotsPolicy: 'allow', active: true };

// CRAWL-DEGRADE-1 — one bit: is retrying worth it?
describe('failure classification', () => {
  test.each<[string, Parameters<typeof classifyFailure>[0], string, ReturnType<typeof classifyFailure>]>([
    // Policy decisions are structural: retrying re-makes the same decision.
    ['an inactive target', 'blocked', 'Target is inactive', 'structural'],
    ['a quarantine', 'quarantined', 'injection signals', 'structural'],
    ['no lane available', 'no_lane_available', 'no key', 'structural'],
    ['a connection reset', 'unreachable', 'ECONNRESET', 'transient'],
    ['a timeout', 'unreachable', 'The operation timed out', 'transient'],
    ['a 503', 'unreachable', 'HTTP 503 from origin', 'transient'],
    ['a page that is genuinely gone (404)', 'unreachable', 'HTTP 404 Not Found', 'structural'],
    ['a page that is genuinely gone (410)', 'unreachable', 'HTTP 410 Gone', 'structural'],
    ['a status number outside an HTTP token, such as a duration', 'unreachable', 'The operation timed out after 410 ms', 'transient'],
    // A 403 is a bot wall far more often than a refusal. Treating it as structural would retire sources that work next run.
    ['a 403', 'unreachable', 'HTTP 403 Forbidden', 'transient'],
    ['an unsupported content-type, which will never become supported', 'empty', 'Unsupported content-type: image/png', 'structural'],
    ['a page that rendered nothing today, which may render something tomorrow', 'empty', 'No visible text in the served HTML', 'transient'],
    ['a missing optional parser, which needs an install', 'empty', 'PDF support needs the optional `unpdf` package. Run `npm install unpdf` to enable it.', 'structural'],
    ['a PDF with no text layer, which needs a vision model', 'empty', 'PDF has no text layer (likely scanned images)', 'structural'],
  ])('classifies %s', (_name, reason, detail, expected) => {
    expect(classifyFailure(reason, detail)).toBe(expected);
  });

  test('a real crawl failure carries the class', async () => {
    const crawler = createCrawler({ userAgent: 'T/1 (+https://t.example.com)', dnsLookup: publicDns });
    const result = await crawler.crawl({ ...target, active: false }, 'https://venue.example.com/x');

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected failure');
    expect(result.failureClass).toBe('structural');
  });
});

// BETTER-SOFT404-1 — advisory only, never filters
describe('empty-state detection', () => {
  test.each([
    'No events scheduled at this time.',
    'There are no upcoming shows.',
    'Nothing scheduled. Check back soon!',
    'Page under construction.',
    'Coming soon.',
    'Page not found.',
  ])('flags %j', (text) => {
    expect(looksLikeEmptyState(text)).toBe(true);
  });

  test('a page with essentially no text is flagged', () => {
    expect(looksLikeEmptyState('   ')).toBe(true);
  });

  test('a real listing is not flagged', () => {
    expect(
      looksLikeEmptyState(
        'The outdoor concert series runs every Friday evening at the riverside stage. ' +
          'July 11 brings Test Band A, and July 18 brings Test Band B. Doors at six.',
      ),
    ).toBe(false);
  });

  test('a long page mentioning "coming soon" in passing is not flagged', () => {
    // The signal is an empty-state phrase AND nothing else on the page.
    const long =
      'Our autumn programme is now open for booking with a full slate of touring acts. '.repeat(10) +
      'A winter season is coming soon.';
    expect(looksLikeEmptyState(long)).toBe(false);
  });

  test('the flag rides on the page, which is still returned in full', async () => {
    globalThis.fetch = (async () =>
      new Response(
        '<html><head><title>Events</title></head><body><main><p>No events scheduled at this time.</p></main></body></html>',
        { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' } },
      )) as typeof fetch;

    const crawler = createCrawler({ userAgent: 'T/1 (+https://t.example.com)', dnsLookup: publicDns });
    const result = await crawler.crawl(target, 'https://venue.example.com/events');

    expect(result.ok).toBe(true);
    if (!result.ok || result.notModified) throw new Error('expected pages');
    expect(result.pages[0]!.likelyEmptyState).toBe(true);
    // Advisory: an off-season venue really IS "no events", and that is a fact
    // a consumer may want to record.
    expect(result.pages[0]!.text).toContain('No events scheduled');
  });
});

// CRAWL-CONTENTKIND-1 — so an extractor improvement can reach old pages
describe('extractor version', () => {
  test('every page is stamped', async () => {
    globalThis.fetch = (async () =>
      new Response(
        '<html><head><title>T</title></head><body><main><p>Concerts every Friday at the riverside stage.</p></main></body></html>',
        { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' } },
      )) as typeof fetch;

    const crawler = createCrawler({ userAgent: 'T/1 (+https://t.example.com)', dnsLookup: publicDns });
    const result = await crawler.crawl(target, 'https://venue.example.com/x');

    if (!result.ok || result.notModified) throw new Error('expected pages');
    expect(result.pages[0]!.extractorVersion).toBe(EXTRACTOR_VERSION);
  });
});

// CRAWL-UA-1 — warn, never throw
describe('user-agent contact warning', () => {
  test('warns when the user agent has no contact', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    resolveConfig({ userAgent: 'AnonymousBot/1.0' });
    expect(warn).toHaveBeenCalledOnce();
    expect(warn.mock.calls[0]![0]).toContain('no contact URL');
  });

  test('stays quiet when a contact URL is present', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    resolveConfig({ userAgent: 'MyBot/1.0 (+https://mysite.com/bot)' });
    expect(warn).not.toHaveBeenCalled();
  });

  test('warns once per user agent', () => {
    // A 500-page run must not print 500 warnings.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    resolveConfig({ userAgent: 'AnonymousBot/1.0' });
    resolveConfig({ userAgent: 'AnonymousBot/1.0' });
    resolveConfig({ userAgent: 'AnonymousBot/1.0' });
    expect(warn).toHaveBeenCalledOnce();
  });
});
