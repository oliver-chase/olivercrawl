// ─── Fallback rungs of the own lane ─────────────────────────────────────────
//
// The rungs that run after the direct fetch fails: render, proxy, Jina and the archive, and the ladder that orders them.
// docs/LANES.md is the rung table.

import { classifyContentType } from '../../core/content-kind.js';
import { looksLikeBlockPage } from '../../core/block-page.js';
import { isQuarantined, buildTextPage } from '../../fetch/build-page.js';
import { buildRungPage, quarantined } from './rung-page.js';
import { readBodyCapped, fetchFollowingSafeRedirects } from '../../fetch/http-mechanics.js';
import { fetchViaWayback } from '../../fetch/wayback-fetch.js';
import { fetchViaJina } from '../../fetch/jina-fetch.js';
import { renderServiceFrom, renderViaService } from '../../fetch/browser-render.js';
import { renderViaLocalChromium } from '../../fetch/local-render.js';
import { emitUsage } from '../../core/usage.js';
import type { ResolvedConfig } from '../../core/config.js';
import type { CrawlOptions, CrawlResult, CrawlTarget } from '../../core/types.js';
import { withOriginMoved } from './origin-moved.js';
import { hasCredentials } from './target-headers.js';

/**
 * WAYBACK-RUNG-1: the archive rung, gated hard.
 *
 * Only for an explicit `allow` posture, and only after every live rung has
 * failed. Returns null when it does not apply, so the caller falls through to
 * its normal failure.
 */
async function archiveFallback(
  url: string,
  config: ResolvedConfig,
  options: CrawlOptions,
  started: number,
): Promise<CrawlResult | null> {
  if (!config.useArchiveFallback) return null;
  // approveCrawlPolicy has already refused disallow and unknown, and freeFallbackLadder stops a
  // credentialed target before it reaches here, so this rung sees only permitted public targets.
  const archived = await fetchViaWayback(url, {
    ...(config.archiveMaxAgeDays === undefined ? {} : { maxAgeDays: config.archiveMaxAgeDays }),
  });
  if (!archived.ok) return null;
  return htmlRungResult(
    config,
    options,
    url,
    started,
    { rung: 'archive', kind: 'fetch', free: true, quarantineDetail: 'Archived capture tripped the prompt-injection guard.' },
    { url, html: archived.html, contentType: 'text/html' },
  );
}

type HtmlRung = { rung: string; kind: 'fetch' | 'render'; free: boolean; quarantineDetail: string };

/**
 * A page built from a rung's HTML, as a result. A quarantine is refused and reported, and an empty page or a
 * bot wall is null so the ladder moves on.
 */
async function htmlRungResult(
  config: ResolvedConfig,
  options: CrawlOptions,
  url: string,
  started: number,
  rung: HtmlRung,
  input: { url: string; html: string; contentType: string; etag?: string | null; lastModified?: string | null },
): Promise<CrawlResult | null> {
  const page = await buildRungPage(config, options, {
    ...input,
    etag: input.etag ?? null,
    lastModified: input.lastModified ?? null,
    baseHost: new URL(url).hostname,
    rung: rung.rung,
  });
  if (isQuarantined(page)) return quarantined(config, url, started, rung.quarantineDetail, page);
  if (!page.text.trim() || looksLikeBlockPage(page.text)) return null;
  const cost = rung.free ? { costUsd: 0 } : {};
  emitUsage(config, { lane: 'own', rung: rung.rung, kind: rung.kind, url, ok: true, latencyMs: Date.now() - started, ...cost });
  return { ok: true, pages: [page] };
}

export type LadderFlags = {
  /** An origin answered with a body that had no usable content. */
  bodyReceived?: boolean;
  /** False when the origin said the page is gone (404 or 410): no live rung can bring it back, but the archive still can. */
  liveRungs?: boolean;
};

/**
 * The remaining FREE rungs, in one order defined once.
 *
 * LANE-EXHAUST-1: local Chromium -> your render service -> your proxy -> Jina. A skipped
 * free rung pushes the crawl into the paid lane sooner than it needed to go,
 * so every failure path routes through here and chooses none of its own.
 */
export async function freeFallbackLadder(
  url: string,
  config: ResolvedConfig,
  options: CrawlOptions,
  started: number,
  priorDetail: string,
  target: CrawlTarget,
  { bodyReceived = false, liveRungs = true }: LadderFlags = {},
): Promise<CrawlResult> {
  const credentialed = hasCredentials(target);
  // Neither render rung gets the target's headers, so a credentialed target would render logged out and the login
  // page could replace the real one. Credentialed targets skip rendering.
  const rendered = credentialed || !liveRungs ? null : await renderFallback(url, config, options, started);
  if (rendered) {
    return withOriginMoved(rendered, priorDetail, rendered.ok && !rendered.notModified ? (rendered.pages[0]?.rung ?? 'render') : 'render', url);
  }

  // CRAWL-PROXY-1: the caller's own proxy comes before the third-party Jina rung
  // and never sees a credentialed target.
  if (!credentialed && liveRungs) {
    const viaProxy = await proxyFallback(url, config, options, started);
    if (viaProxy) return withOriginMoved(viaProxy, priorDetail, 'proxy', url);
  }

  // JINA-CREDENTIAL-1: the Jina rung is a PUBLIC
  // third-party proxy — we hand it a URL and it fetches the page itself. For a
  // target the caller gave credentials for (a members-only calendar, a partner
  // feed), that is all downside:
  //
  //   - the private URL, including anything in its query string, is disclosed
  //     to a third party the caller never agreed to share it with;
  //   - the fetch cannot succeed anyway, because Jina does not have and must
  //     never be given those credentials.
  //
  // So a credentialed target stops at the rungs we run ourselves. The render
  // rungs above are fine — those are the caller's own infrastructure.
  if (credentialed) {
    return {
      ok: false,
      reason: 'unreachable',
      detail: `${priorDetail} (Jina rung skipped: this target carries credentials and its URL must not be sent to a third-party proxy.)`,
      lane: 'own',
      ...(bodyReceived ? { bodyReceived: true } : {}),
    };
  }

  const viaJina: CrawlResult = liveRungs
    ? await jinaFallback(url, config, options, started, priorDetail)
    : { ok: false, reason: 'unreachable', detail: priorDetail, lane: 'own' };
  // Jina follows the same redirect from its own IPs, so a sold or parked domain returns the new owner's
  // content under the old URL, and the refusal travels with the page.
  if (viaJina.ok) return withOriginMoved(viaJina, priorDetail, 'jina', url);

  // BODY-RECEIVED-1 is attached HERE, outside each rung. A rung knows
  // whether IT got content; only the ladder knows whether the original fetch
  // did, and that is the fact a consumer needs to tell "the site is down" from
  // "the site served a shell".
  const withBodyFlag = (result: CrawlResult): CrawlResult =>
    result.ok || !bodyReceived ? result : { ...result, bodyReceived: true };

  // Last, and only for an explicitly permitted target — see archiveFallback.
  if (target.robotsPolicy === 'allow') {
    const archived = await archiveFallback(url, config, options, started);
    // The archive capture is of the ORIGINAL url, so it is less wrong than a
    // live fetch of the new owner — but with archiveMaxAgeDays unset the
    // capture can post-date the sale, so it carries the flag too.
    if (archived) return withOriginMoved(archived, priorDetail, 'archive', url);
  }
  return withBodyFlag(viaJina);
}

/**
 * Render rung: our own browser service, for pages whose content only exists
 * after JavaScript runs. Returns null when no service is configured (skip to
 * the next rung) — a configured-but-broken service is reported as a failed usage
 * event, and the ladder then moves on.
 */
async function renderFallback(
  url: string,
  config: ResolvedConfig,
  options: CrawlOptions,
  started: number,
): Promise<CrawlResult | null> {
  // FREE rung first: local Chromium (config.localRender). Costs nothing on
  // a machine that has it; silently absent everywhere else. Only then the
  // remote render service.
  const localHtml = await renderViaLocalChromium(
    url,
    config.localRender === true,
    config.browserActions ?? [],
    config.dnsLookup,
    // A security refusal here is the signal an operator needs.
    (reason) =>
      emitUsage(config, { lane: 'own', rung: 'local-render', kind: 'render', url, ok: false, latencyMs: Date.now() - started, error: reason }),
  );
  if (localHtml) {
    // LADDER-QUALITY-1: a rendered bot-wall interstitial is a rung failure, so the ladder moves on to the
    // rungs that can retrieve the real page.
    const local = await htmlRungResult(
      config,
      options,
      url,
      started,
      { rung: 'local-render', kind: 'render', free: true, quarantineDetail: 'Locally rendered content tripped the prompt-injection guard.' },
      { url, html: localHtml, contentType: 'text/html' },
    );
    if (local) return local;
    // Rendered but still empty — fall through to the remote service.
  }

  if (!renderServiceFrom(config)) return null;

  try {
    const rendered = await renderViaService(url, config);
    if (!rendered) return null;
    // A render that still yields nothing is not a success — let the caller
    // fall through to Jina and return no empty page.
    return await htmlRungResult(
      config,
      options,
      url,
      started,
      { rung: 'browser-render', kind: 'render', free: false, quarantineDetail: 'Rendered content tripped the prompt-injection guard.' },
      rendered,
    );
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    emitUsage(config, { lane: 'own', rung: 'browser-render', kind: 'render', url, ok: false, latencyMs: Date.now() - started, error: detail });
    return null; // broken render service must not end the crawl — Jina may still work
  }
}

/**
 * CRAWL-PROXY-1: retry a blocked page through the caller's `proxyFetch`.
 * Returns null whenever the rung does not apply or does not help, so the ladder moves on.
 */
async function proxyFallback(
  url: string,
  config: ResolvedConfig,
  options: CrawlOptions,
  started: number,
): Promise<CrawlResult | null> {
  if (!config.proxyFetch) return null;
  const fail = (error: string) =>
    emitUsage(config, { lane: 'own', rung: 'proxy', kind: 'fetch', url, ok: false, latencyMs: Date.now() - started, error });
  try {
    const requestUrl = new URL(url);
    const response = await fetchFollowingSafeRedirects(
      requestUrl,
      config,
      options.timeoutMs ?? config.defaults.timeoutMs,
      {},
      {},
      5,
      config.proxyFetch,
    );
    if (!response.ok) {
      fail(`HTTP ${response.status}`);
      return null;
    }
    const contentType = response.headers.get('content-type') || '';
    if (classifyContentType(contentType) !== 'html') {
      fail(`Unsupported content-type: ${contentType || 'unknown'}`);
      return null;
    }
    const result = await htmlRungResult(
      config,
      options,
      url,
      started,
      { rung: 'proxy', kind: 'fetch', free: true, quarantineDetail: 'Content fetched through the proxy tripped the prompt-injection guard.' },
      {
        url: response.url || requestUrl.toString(),
        html: await readBodyCapped(response, config.limits.maxBodyBytes),
        contentType,
        etag: response.headers.get('etag'),
        lastModified: response.headers.get('last-modified'),
      },
    );
    if (!result) fail('still blocked or empty');
    return result;
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
    return null;
  }
}

/** Free, keyless last resort — see fetch/jina-fetch.ts for why it clears
 *  bot walls the direct fetch cannot. */
async function jinaFallback(
  url: string,
  config: ResolvedConfig,
  options: CrawlOptions,
  started: number,
  priorDetail: string,
): Promise<CrawlResult> {
  try {
    const jina = await fetchViaJina(url, {
      ...(config.jinaEndpoint ? { endpoint: config.jinaEndpoint } : {}),
      ...(options.timeoutMs ? { timeoutMs: options.timeoutMs } : {}),
    });
    if (!jina || !jina.text.trim()) {
      emitUsage(config, { lane: 'own', rung: 'jina', kind: 'fetch', url, ok: false, latencyMs: Date.now() - started, error: 'no content' });
      return { ok: false, reason: 'unreachable', detail: priorDetail, lane: 'own' };
    }

    const page = await buildTextPage({
      url,
      text: jina.text,
      maxTextChars: options.maxTextChars ?? config.defaults.maxTextChars,
      contentKind: 'text',
      contentType: 'text/markdown',
      rung: 'jina',
      lane: 'own',
      title: jina.title,
      bodySource: jina.text,
    });
    if (isQuarantined(page)) return quarantined(config, url, started, 'Prompt-injection signals in fallback content.', page);

    emitUsage(config, { lane: 'own', rung: 'jina', kind: 'fetch', url, ok: true, latencyMs: Date.now() - started, costUsd: 0 });
    return { ok: true, pages: [page] };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    emitUsage(config, { lane: 'own', rung: 'jina', kind: 'fetch', url, ok: false, latencyMs: Date.now() - started, error: detail });
    return { ok: false, reason: 'unreachable', detail: priorDetail, lane: 'own' };
  }
}
