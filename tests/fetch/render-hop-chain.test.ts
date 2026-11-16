import { describe, expect, test } from 'vitest';
import { readFileSync } from 'node:fs';
import { followRedirects } from '@/fetch/local-render';

// RENDER-HOP-2: the render rung must follow redirects ITSELF.
//
// Chromium follows 3xx inside its network stack, so a route handler sees only
// the original request. Unless the rung fetches each hop itself, an off-site
// hop in a `site -> off-site -> site` chain receives a real request and the
// landing check passes because the chain came home.
//
// The hop walker is driven directly below. playwright's import is deliberately invisible to bundlers,
// so the route handler around it cannot be mocked, and its wiring is asserted on the source instead.
// The live suite drives the real chain.

const source = readFileSync(new URL('../../src/fetch/local-render.ts', import.meta.url), 'utf8');
// Anchored on the comment inside the handler, because the decision id also
// appears far above and a slice from there would sweep in the other branch.
const navigationBranchRaw = source.slice(
  source.indexOf('follow the redirect chain OURSELVES'),
  source.indexOf('await page.goto('),
);

/**
 * Comments stripped before matching. The branch's own comment EXPLAINS why
 * route.continue() is wrong, so a test reading raw text matches the prose and
 * fails on correct code — it would assert against the documentation
 * and not the behaviour.
 */
const navigationBranch = navigationBranchRaw
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/\/\/.*$/gm, '');

describe('the render rung follows redirects itself', () => {
  test('navigation hops are fetched by the pinned pool with redirects disabled', () => {
    // redirect: 'manual' is what stops the fetch following the chain where the guard cannot see it,
    // and the pinned pool is what stops Chromium resolving a host the check did not approve.
    const helper = readFileSync(new URL('../../src/fetch/render-transport.ts', import.meta.url), 'utf8');
    expect(helper).toMatch(/redirect:\s*'manual'/);
    expect(source).toMatch(/const pinnedFetch = pooledFetchFor\(dnsLookup\)/);
    expect(source).toMatch(/const fetchHop = \(hopUrl: string\) => pinnedRequest\(pinnedFetch, request, hopUrl\)/);
    expect(navigationBranch).toMatch(/followRedirects\(/);
    expect(navigationBranch).toMatch(/assertLandedSameSite\(hopUrl, url, dnsLookup\)/);
    expect(navigationBranch).toMatch(/fetchHop/);
  });

  test('the navigation branch does not hand the request back to Chromium', () => {
    // route.continue() on a navigation request restores the defect exactly:
    // the network stack takes over and every subsequent hop is invisible.
    expect(navigationBranch).not.toMatch(/route\.continue\(\)/);
  });

});

describe('followRedirects walks a chain hop by hop', () => {
  const redirect = (location: string) => ({ location });
  const landed = { location: null, body: 'page' };

  test('each hop is checked before its request is made', async () => {
    // Order is the point. Checking after the fetch is the original bug in a new shape: the private
    // server has already received the request.
    const events: string[] = [];
    const chain: Record<string, { location: string | null }> = {
      'https://site.example.com/a': redirect('/b'),
      'https://site.example.com/b': landed,
    };
    const answer = await followRedirects(
      'https://site.example.com/a',
      async (hop) => void events.push(`check ${hop}`),
      async (hop) => (events.push(`fetch ${hop}`), chain[hop]!),
    );
    expect(answer).toBe(landed);
    expect(events).toEqual([
      'check https://site.example.com/a',
      'fetch https://site.example.com/a',
      'check https://site.example.com/b',
      'fetch https://site.example.com/b',
    ]);
  });

  test('a refused hop is never requested', async () => {
    const fetched: string[] = [];
    const walk = followRedirects(
      'https://site.example.com/a',
      async (hop) => {
        if (hop.includes('127.0.0.1')) throw new Error('Blocked private address');
      },
      async (hop) => (fetched.push(hop), hop.endsWith('/a') ? redirect('http://127.0.0.1:8080/x') : landed),
    );
    await expect(walk).rejects.toThrow(/Blocked/);
    expect(fetched).toEqual(['https://site.example.com/a']);
  });

  test('the chain is bounded', async () => {
    // Following redirects by hand means owning the loop, and a loop without a ceiling is a spin.
    let requests = 0;
    const answer = await followRedirects('https://site.example.com/loop', async () => {}, async () => (requests++, redirect('/loop')));
    expect(answer).toBeNull();
    expect(requests).toBe(6);
  });

  test('a relative Location resolves against the current hop', async () => {
    const fetched: string[] = [];
    await followRedirects(
      'https://site.example.com/dir/a',
      async () => {},
      async (hop) => (fetched.push(hop), fetched.length === 1 ? redirect('b') : landed),
    );
    expect(fetched[1]).toBe('https://site.example.com/dir/b');
  });
});
