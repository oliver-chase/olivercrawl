// ─── Origin-moved detection ─────────────────────────────────────────────────
//
// Did the direct rung refuse because the origin moved to a different site, and flagging a result that a later rung served.

import type { CrawlResult } from '../../core/types.js';

/**
 * The registrable part of a host: the last two labels, or the last three under a two-letter country
 * code with a generic second level (shop.co.uk is a different site from other.co.uk). A short list
 * stands in for the public suffix list.
 */
function registrableHost(host: string): string {
  const labels = host.toLowerCase().split('.');
  const generic = new Set(['co', 'com', 'org', 'net', 'gov', 'edu', 'ac']);
  const take = labels.length >= 3 && labels[labels.length - 1]!.length === 2 && generic.has(labels[labels.length - 2]!) ? 3 : 2;
  return labels.slice(-take).join('.');
}

/**
 * Did the direct rung refuse because the origin moved to a DIFFERENT SITE?
 *
 * Decided from the URL in the refusal, whatever wording the guard used: the
 * guard checks https before off-domain, so a parked domain's 301 to plain http
 * is refused as "non-https" and never says off-domain.
 *
 * Registrable-domain comparison, so `site.com` -> `events.site.com` counts as
 * the same site: same publisher, and flagging it adds review load for a non-event.
 */
export function isOffDomainRefusal(detail: string, requestedUrl: string): boolean {
  const found = detail.match(/https?:\/\/[^\s)]+/);
  if (!found) return false;
  try {
    return registrableHost(new URL(found[0]).hostname) !== registrableHost(new URL(requestedUrl).hostname);
  } catch {
    return false;
  }
}

/**
 * Attach ORIGIN-MOVED-1 to any rung that served a page past an off-domain
 * refusal. The ladder calls it for every rung, so the flag holds whichever rung won.
 */
export function withOriginMoved(result: CrawlResult, priorDetail: string, servedBy: string, requestedUrl: string): CrawlResult {
  if (!result.ok || result.notModified) return result;
  if (!isOffDomainRefusal(priorDetail, requestedUrl)) return result;
  return { ...result, originMoved: { refusal: priorDetail, servedBy } };
}
