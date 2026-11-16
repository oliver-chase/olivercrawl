// ─── Jina Reader fallback: the last resort in the resolution loop ───────────
//
// A site that blocks a direct crawl is not dropped; the crawl falls back. The direct crawl fails
// on three common blockers:
//   1. the site moved and off-domain-redirects to a new host,
//   2. the host bot-walls the caller's / browser / Googlebot UAs by IP, and
//   3. the content is only there after JS runs.
// Jina Reader (https://r.jina.ai/<url>) clears all three at once, for free and
// with no API key: it follows redirects, renders the page, and fetches from
// ITS OWN IPs (so an IP/fingerprint bot-wall on the origin never sees the caller).
//
// Used ONLY as a fallback (after the direct fetch fails), so a normal source's
// own richer, first-party HTML is always preferred and this third-party
// dependency is off the hot path. Returns null on any failure — callers treat
// null as "fallback did not help," never as empty content.

/** JINA-SELFHOST-1: the default endpoint; config.jinaEndpoint points the rung at a self-hosted reader. */
const JINA_ENDPOINT = 'https://r.jina.ai/';
const JINA_TIMEOUT_MS = 30_000;
const JINA_MAX_BYTES = 600_000;

import { assertPublicHost } from './host-policy.js';
import { dropBody, readBodyCapped } from './http-mechanics.js';

export type JinaFetchResult = { title: string | null; text: string };

// The only host this module contacts is the reader endpoint, but the target URL is handed to a
// third-party service, so it must be a public https URL: a private or internal address is refused
// before any request leaves.
export async function fetchViaJina(
  targetUrl: string,
  opts?: { fetchImpl?: typeof fetch; endpoint?: string; timeoutMs?: number },
): Promise<JinaFetchResult | null> {
  const doFetch = opts?.fetchImpl ?? fetch;
  const endpoint = (opts?.endpoint || JINA_ENDPOINT).replace(/\/+$/, '');
  let target: URL;
  try {
    target = new URL(targetUrl);
    if (target.protocol !== 'https:') return null;
    // A URL with credentials in it would be handed to a third party, so it is refused before any request.
    if (target.username || target.password) return null;
    assertPublicHost(target.hostname);
  } catch {
    return null;
  }

  const controller = new AbortController();
  // TIMEOUT-JINA-1: the caller's timeoutMs binds here like on every rung, since a caller cannot see which
  // rung is running. The 30s default applies only when the caller sets none, because this rung renders the
  // page remotely and is legitimately slower than a direct fetch.
  const timeoutId = setTimeout(() => controller.abort(), opts?.timeoutMs ?? JINA_TIMEOUT_MS);
  try {
    const res = await doFetch(`${endpoint}/${target.toString()}`, {
      method: 'GET',
      headers: {
        // Ask Jina for the readable content.
        'X-Return-Format': 'text',
        accept: 'text/plain',
      },
      signal: controller.signal,
    });
    if (!res.ok) {
      dropBody(res);
      return null;
    }
    const body = await readBodyCapped(res, JINA_MAX_BYTES);
    return parseJinaResponse(body);
  } catch {
    return null;
  } finally {
    clearTimeout(timeoutId);
  }
}

// Jina prefixes its output with `Title:` / `URL Source:` / `Markdown Content:`
// lines. Split the title off and treat a Jina-reported upstream error
// ("Warning: Target URL returned error 404") as no content. Exported for tests.
export function parseJinaResponse(body: string): JinaFetchResult | null {
  const titleMatch = body.match(/^Title:\s*(.+)$/m);
  const title = titleMatch?.[1]?.trim() ?? null;

  // Jina reports the origin's own failure inline with a 200 — don't mistake it
  // for content.
  if (/Warning:\s*Target URL returned error \d{3}/i.test(body) || /^Title:\s*(File not found|Just a moment|Access denied|Attention Required)/im.test(body)) {
    return null;
  }

  const contentIdx = body.indexOf('Markdown Content:');
  const content = (contentIdx >= 0 ? body.slice(contentIdx + 'Markdown Content:'.length) : body).trim();
  // Too little to be a real page — treat as a miss so the caller doesn't route
  // a source to a dead fallback.
  if (content.replace(/\s+/g, ' ').trim().length < 200) return null;

  return { title, text: content };
}
