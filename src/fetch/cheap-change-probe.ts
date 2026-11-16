// ─── Cheap pre-fetch change probe ───────────────────────────────────────────
//
// A GET that reads ETag/Last-Modified without pulling the page when the origin
// sends them, and a capped body hash when it does not, so an unchanged page can
// be skipped before it costs a full fetch.

import { pooledFetchFor } from './connection-pool.js';
import {
  assertHostResolvesToPublicAddress,
  assertRequestUrlAllowed,
  assertTargetEligible,
  assertRedirectUrlAllowed,
} from './host-policy.js';
import { sha256Hex } from '../core/hash.js';
import { dropBody, followManualRedirects, readBytesPrefix } from './http-mechanics.js';
import { DEFAULT_USER_AGENT } from '../core/config.js';
import type { DnsLookupFn, CrawlTarget } from '../core/types.js';

/** A cheap "has this page changed" fingerprint. Cheaper than a full crawl by
 *  orders of magnitude: a HEAD/ranged GET and a hash, no parsing, no LLM. */
export type CheapChangeSignal = {
  etag: string | null;
  lastModified: string | null;
  bodyHash: string | null;
};

const PROBE_TIMEOUT_MS = 8_000;
const PROBE_MAX_REDIRECTS = 4;
const PROBE_MAX_BODY_BYTES = 200_000; // enough to hash a shell page

/**
 * A plain, unauthenticated, bounded GET — never routed through the paid
 * render service or Apify. Reuses the same per-source URL policy guard
 * (SSRF/host/legal-tier) the real crawl uses. Returns null on ANY failure,
 * and null never means "unchanged".
 */
export async function probeCheapChangeSignal(
  source: CrawlTarget,
  url: string,
  // PROBE-DNS-SEAM-1: injectable, like every other fetch path here.
  opts?: { dnsLookup?: DnsLookupFn },
): Promise<CheapChangeSignal | null> {
  let safeUrl: URL;
  try {
    assertTargetEligible(source);
    safeUrl = assertRequestUrlAllowed(source, url);
    // Static string checks alone don't catch DNS rebinding (a hostname
    // that reads as public but resolves to a private address).
    await assertHostResolvesToPublicAddress(safeUrl.hostname, opts?.dnsLookup);
  } catch {
    return null;
  }

  const signal = AbortSignal.timeout(PROBE_TIMEOUT_MS);

  try {
    // Redirects are followed by hand, each hop validated same-site https and publicly resolved with the
    // caller's resolver before any request goes to it.
    const walk = await followManualRedirects(safeUrl, {
      doFetch: pooledFetchFor(opts?.dnsLookup),
      maxHops: PROBE_MAX_REDIRECTS,
      init: () => ({ method: 'GET', headers: { 'User-Agent': DEFAULT_USER_AGENT }, signal }),
      onRedirect: async (location, from) => {
        const next = assertRedirectUrlAllowed(source, new URL(location, from).toString());
        await assertHostResolvesToPublicAddress(next.hostname, opts?.dnsLookup);
        return next;
      },
    });
    if (walk.stopped) {
      dropBody(walk.response);
      return null;
    }
    const response: Response = walk.response;

    if (response.status < 200 || response.status >= 300) {
      return null;
    }

    const etag = response.headers.get('etag');
    const lastModified = response.headers.get('last-modified');

    // Only pay for the body-hash fallback when neither header is present —
    // most static/server-rendered pages send one of these, and reading a
    // capped body is cheap either way.
    let bodyHash: string | null = null;
    if (!etag && !lastModified) {
      // A body that cannot be read leaves the hash null, because two failed reads would otherwise match.
      // A body past the cap could differ only after it, so a capped read gives no hash to compare, and such a
      // page with no validators is always fetched. That costs a fetch and never misses a change.
      const read = await readBytesPrefix(response, PROBE_MAX_BODY_BYTES).catch(() => null);
      bodyHash = read === null || read.capped ? null : await sha256Hex(read.bytes);
    } else {
      dropBody(response);
    }

    return { etag, lastModified, bodyHash };
  } catch {
    return null;
  }
}

/**
 * True ONLY when both sides have a real, comparable signal that matches.
 * Strong signals (etag, then lastModified) are checked first; body hash is
 * the last resort, and only when it's present on both sides too.
 */
export function cheapSignalsMatch(prior: CheapChangeSignal | null | undefined, current: CheapChangeSignal | null): boolean {
  if (!prior || !current) return false;
  if (prior.etag && current.etag) return prior.etag === current.etag;
  if (prior.lastModified && current.lastModified) return prior.lastModified === current.lastModified;
  if (prior.bodyHash && current.bodyHash) return prior.bodyHash === current.bodyHash;
  return false;
}
