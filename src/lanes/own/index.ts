// ─── LANE 1: the own lane ───────────────────────────────────────────────────
//
// Our crawler. No API keys, no vendor accounts, no per-call cost — platform
// fetch, cheerio parsing, and this package's own guards. It is what makes the
// package worth having: everything a vendor charges for on a plain HTML page,
// done here for free, with controls a vendor does not offer at all.
//
// Every rung in this lane is free and needs no credentials, except the remote
// render service, which runs on infrastructure YOU control — that is why it
// sits here and stays out of the vendor lane. Falling through to the vendor lane
// happens only when the caller explicitly asked for it.
//
// docs/LANES.md is the rung table and the reasoning behind the order. Keep it
// there: `freeFallbackLadder` below is the single definition of the
// order, and a second copy in this header would drift from it.
import { classifyContentType, refineKindByUrl } from '../../core/content-kind.js';
import { extractPdfText } from '../../fetch/pdf-extract.js';
import { forgetWinningRung, shouldSkipDirectFetch } from '../../core/rung-memory.js';
import { looksLikeBlockPage } from '../../core/block-page.js';
import { isQuarantined, buildTextPage } from '../../fetch/build-page.js';
import { buildRungPage, quarantined } from './rung-page.js';
import { dropBody, parseRetryAfter, readBodyCapped, readBytesCapped, fetchFollowingSafeRedirects } from '../../fetch/http-mechanics.js';
import { assertHostResolvesToPublicAddress, DnsLookupError } from '../../fetch/host-policy.js';
import { emitUsage } from '../../core/usage.js';
import { throttleHost, recordHostLatency } from '../../core/host-throttle.js';
import type { ResolvedConfig } from '../../core/config.js';
import type { CrawlOptions, CrawlResult, CrawlTarget } from '../../core/types.js';
import { approveCrawlPolicy, publishedCrawlDelayMs } from './robots-policy.js';
import { freeFallbackLadder, type LadderFlags } from './fallback-rungs.js';
import { targetHeaders } from './target-headers.js';
export { ROBOTS_CACHE_TTL_MS, ROBOTS_FAILURE_TTL_MS, publishedCrawlDelayMs, __clearRobotsCacheForTests, resolveTargetPolicy, approveCrawlPolicy } from './robots-policy.js';

/** Crawl a single URL with the own lane. */
export async function crawlWithOwnLane(
  target: CrawlTarget,
  url: string,
  config: ResolvedConfig,
  options: CrawlOptions = {},
): Promise<CrawlResult> {
  const maxTextChars = options.maxTextChars ?? config.defaults.maxTextChars;
  const timeoutMs = options.timeoutMs ?? config.defaults.timeoutMs;
  const started = Date.now();
  const fail = (detail: string): CrawlResult => {
    emitUsage(config, { lane: 'own', rung: 'fetch', kind: 'fetch', url, ok: false, latencyMs: Date.now() - started, error: detail });
    return { ok: false, reason: 'empty', detail, lane: 'own' };
  };

  // 1. Policy — every refusal here happens before any content fetch. The
  // shared gate (also run lane-independently by crawl()) plus the own-lane-
  // only DNS check, which protects the socket THIS process is about to open.
  let requestUrl: URL;
  try {
    requestUrl = await approveCrawlPolicy(target, url, config);
    await assertHostResolvesToPublicAddress(requestUrl.hostname, config.dnsLookup);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    emitUsage(config, { lane: 'own', rung: 'policy', kind: 'fetch', url, ok: false, latencyMs: Date.now() - started, error: detail });
    // A resolver failure is a transport fault that can clear, so it is reported as unreachable and not as a policy refusal.
    if (error instanceof DnsLookupError) return { ok: false, reason: 'unreachable', detail, lane: 'own' };
    return { ok: false, reason: 'blocked', detail, lane: 'own' };
  }

  // Politeness: hold the per-host gap BEFORE the request, after policy has
  // already approved it — no point rate-limiting a fetch we will refuse.
  // ROBOTS-DELAY-1: the site's own Crawl-delay is a floor for the gap, and a slower configured interval wins.
  const publishedDelay = publishedCrawlDelayMs(requestUrl.hostname) ?? 0;
  await throttleHost(
    requestUrl.hostname,
    Math.max(config.minHostIntervalMs ?? 0, publishedDelay),
    config.adaptiveThrottleMultiplier ?? 0,
  );

  // BETTER-RUNGMEMORY-1: if this host is known to reject the plain fetch and
  // succeed on a later rung, skip straight there. When the remembered path
  // fails, the memory is dropped and the direct fetch runs after all.
  // LANE-ONCE-1: when the remembered path fails, its ladder has already tried every later rung, so a failure
  // of the direct fetch that follows returns that result and does not run the ladder a second time.
  let spentLadder: CrawlResult | null = null;
  const ladder = (priorDetail: string, flags?: LadderFlags): Promise<CrawlResult> =>
    spentLadder ? Promise.resolve(spentLadder) : freeFallbackLadder(url, config, options, started, priorDetail, target, flags);
  if (config.rungMemory !== false && shouldSkipDirectFetch(config.rungMemoryStore, requestUrl.hostname)) {
    const viaMemory = await ladder('Direct fetch skipped: this host is known to serve it only via a later rung.');
    if (viaMemory.ok) return viaMemory;
    // A quarantined page is a policy decision, so the remembered rung stays and the ladder does not run again.
    if (viaMemory.reason === 'quarantined') return viaMemory;
    forgetWinningRung(config.rungMemoryStore, requestUrl.hostname);
    spentLadder = viaMemory;
  }

  // 2-4. Direct fetch, conditional when the caller has validators from a
  // previous crawl of this URL.
  let response: Response;
  const fetchStartedAt = Date.now();
  try {
    response = await fetchFollowingSafeRedirects(
      requestUrl,
      config,
      timeoutMs,
      { etag: options.etag, lastModified: options.lastModified },
      targetHeaders(target),
    );
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    emitUsage(config, { lane: 'own', rung: 'fetch', kind: 'fetch', url, ok: false, latencyMs: Date.now() - started, error: detail });
    // Direct fetch failed — exhaust every remaining FREE rung before giving
    // up (and long before anything paid is considered).
    return ladder(detail);
  }

  // How long the origin took is the input to adaptive pacing.
  recordHostLatency(requestUrl.hostname, Date.now() - fetchStartedAt);

  // A 304 to a conditional request means nothing changed, reported distinctly from "empty". With no
  // validators sent, a 304 is a fault.
  if (response.status === 304 && (options.etag || options.lastModified)) {
    dropBody(response);
    emitUsage(config, { lane: 'own', rung: 'conditional', kind: 'fetch', url, ok: true, latencyMs: Date.now() - started, costUsd: 0 });
    return { ok: true, pages: [], notModified: true };
  }

  if (!response.ok) {
    // CRAWL-BACKOFF-1: the origin's Retry-After is surfaced for the retry loop to honour.
    const retryAfterMs = parseRetryAfter(response.headers.get('retry-after'));
    dropBody(response);
    const detail = retryAfterMs
      ? `HTTP ${response.status} (origin asked to wait ${Math.round(retryAfterMs / 1000)}s)`
      : `HTTP ${response.status}`;
    emitUsage(config, { lane: 'own', rung: 'fetch', kind: 'fetch', url, ok: false, latencyMs: Date.now() - started, error: detail });
    // A 403/429/503 is where a real browser most often succeeds — render
    // rungs come BEFORE Jina here (LANE-EXHAUST-1).
    // A 404 or 410 is the origin saying the page is gone, so no live rung can bring it back. Only the archive can.
    const gone = response.status === 404 || response.status === 410;
    const fallback = await ladder(detail, { liveRungs: !gone });
    if (!fallback.ok && retryAfterMs) return { ...fallback, retryAfterMs };
    return fallback;
  }

  const contentType = response.headers.get('content-type') || '';
  const kindRaw = classifyContentType(contentType);
  if (!kindRaw) {
    // Still refused: images, video, PDFs, binaries. HTML-parsing a JPEG
    // produces confident nonsense, and a PDF needs a real parser.
    dropBody(response);
    return fail(`Unsupported content-type: ${contentType || 'unknown'}`);
  }
  const contentKind = refineKindByUrl(kindRaw, response.url || requestUrl.toString());
  const pageMeta = {
    url: response.url || requestUrl.toString(),
    contentType,
    rung: 'fetch',
    etag: response.headers.get('etag'),
    lastModified: response.headers.get('last-modified'),
  };

  // CRAWL-PDF-1: a PDF is bytes — decoding it as a string first
  // would corrupt it, so it is read and parsed before the text path.
  if (contentKind === 'pdf') {
    // CRAWL-PDF-CAP-1: the same byte cap as the text path, applied before the bytes are parsed.
    const announced = Number(response.headers.get('content-length') || 0);
    if (announced > config.limits.maxBodyBytes) return fail(`PDF too large: content-length ${announced} > ${config.limits.maxBodyBytes}`);
    let buffer: Uint8Array;
    try {
      buffer = await readBytesCapped(response, config.limits.maxBodyBytes);
    } catch (error) {
      return fail(error instanceof Error ? error.message : String(error));
    }
    const extracted = await extractPdfText(buffer);
    if (!extracted.ok) return fail(extracted.detail);

    const pdfPage = await buildTextPage({ ...pageMeta, lane: 'own', maxTextChars, text: extracted.text, contentKind: 'pdf' });
    if (isQuarantined(pdfPage)) return quarantined(config, url, started, 'Prompt-injection signals in PDF content.', pdfPage);
    emitUsage(config, { lane: 'own', rung: 'fetch', kind: 'fetch', url, ok: true, latencyMs: Date.now() - started, costUsd: 0 });
    return { ok: true, pages: [pdfPage] };
  }

  const html = await readBodyCapped(response, config.limits.maxBodyBytes);

  // CRAWL-FEED-1: a data document (ICS, CSV, JSON, RSS/Atom) is delivered
  // verbatim, and parsing it into events or rows belongs to the caller. It
  // still passes the injection guard: a feed is untrusted remote text.
  if (contentKind !== 'html') {
    const dataPage = await buildTextPage({ ...pageMeta, lane: 'own', maxTextChars, text: html, contentKind, bodySource: html });
    if (isQuarantined(dataPage)) return quarantined(config, url, started, `Prompt-injection signals in ${contentKind} content.`, dataPage);
    if (!dataPage.text.trim()) return fail(`Empty ${contentKind} document`);
    emitUsage(config, { lane: 'own', rung: 'fetch', kind: 'fetch', url, ok: true, latencyMs: Date.now() - started, costUsd: 0 });
    return { ok: true, pages: [dataPage] };
  }
  const page = await buildRungPage(config, options, { ...pageMeta, html, baseHost: requestUrl.hostname });

  if (isQuarantined(page)) {
    const detail = 'Content tripped the prompt-injection guard and was quarantined.';
    return quarantined(config, url, started, detail, page);
  }

  if (!page.text.trim()) {
    // Served HTML had no readable text — a JS shell. BODY-RECEIVED-1: the origin did answer, which only
    // this point knows, so the ladder is told.
    return ladder('No visible text in the served HTML', { bodyReceived: true });
  }

  // THIN-PAGE-1: the page parsed and has text, but too little of it. A
  // JavaScript page often ships its nav and footer in the HTML and nothing
  // else, which passes an "is it empty" check while carrying no content.
  // Only runs when a caller sets a threshold — see renderWhenTextBelow.
  const thinThreshold = config.renderWhenTextBelow ?? 0;
  if (thinThreshold > 0 && page.text.trim().length < thinThreshold) {
    const rendered = await ladder(`Fetched page had only ${page.text.trim().length} characters (threshold ${thinThreshold})`, {
      bodyReceived: true,
    });
    // Keep the thin page if nothing better came back — it is still the page.
    if (rendered.ok && !rendered.notModified && (rendered.pages[0]?.text.length ?? 0) > page.text.length) {
      return rendered;
    }
  }

  // LADDER-QUALITY-1: a bot wall served with HTTP 200. The text exists but it
  // is the wall — treat it exactly like the 403 form of the
  // same wall and try the rungs that clear it.
  if (looksLikeBlockPage(page.text)) {
    return ladder('Served a bot-wall interstitial (HTTP 200)', { bodyReceived: true });
  }

  emitUsage(config, { lane: 'own', rung: 'fetch', kind: 'fetch', url, ok: true, latencyMs: Date.now() - started, costUsd: 0 });
  return { ok: true, pages: [page] };
}
