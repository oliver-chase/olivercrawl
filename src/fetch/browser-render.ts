// ─── Browser render rung (own lane) ─────────────────────────────────────────
//
// Renders a JS-only page through a browser service and returns its HTML. It sits in the OWN lane because
// the endpoint is infrastructure the caller controls. Only the render call lives here; the lane orchestrates.

import { assertRedirectUrlAllowedForHost } from './host-policy.js';
import type { ResolvedConfig } from '../core/config.js';

const RENDER_TIMEOUT_MS = 30_000;

export type RenderResult = {
  url: string;
  status: number;
  html: string;
  contentType: string;
};

/** Validate the configured endpoint. https-only: the rendered HTML is fed
 *  straight into extraction, so a plaintext hop would let anyone on the path
 *  rewrite what the crawler believes a page said. */
export function renderServiceFrom(config: ResolvedConfig): { url: string; token: string } | null {
  const configured = config.browserRender;
  if (!configured?.url) return null;
  try {
    const parsed = new URL(configured.url);
    if (parsed.protocol !== 'https:') return null;
    return { url: configured.url.replace(/\/+$/, ''), token: configured.token ?? '' };
  } catch {
    return null;
  }
}

/**
 * Render one URL. Returns null when no service is configured — callers treat
 * that as "this rung is unavailable", never as an error.
 *
 * Throws only on a real service failure, so the caller can distinguish
 * "not configured" (null) from "configured but broken" (throw) and report
 * the second honestly, with no silent degrading.
 */
export async function renderViaService(targetUrl: string, config: ResolvedConfig): Promise<RenderResult | null> {
  const service = renderServiceFrom(config);
  if (!service) return null;

  const headers: Record<string, string> = {
    'content-type': 'application/json',
    'user-agent': config.userAgent,
  };
  if (service.token) headers.authorization = `Bearer ${service.token}`;

  const response = await fetch(service.url, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      url: targetUrl,
      options: { timeout: RENDER_TIMEOUT_MS, blockAds: true, waitUntil: 'domcontentloaded' },
    }),
    signal: AbortSignal.timeout(RENDER_TIMEOUT_MS),
  });

  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new Error(`Browser render service HTTP ${response.status}: ${body.slice(0, 200)}`);
  }

  const data = (await response.json()) as Partial<RenderResult> & { error?: string };
  if (data.error) throw new Error(`Browser render service error: ${data.error}`);
  if (!data.html) throw new Error('Browser render service returned no HTML');

  // RENDER-REDIRECT-2: the service says where it LANDED, and that value is trusted all the way into
  // buildPage, so a redirect off the requested site is refused here, where the service's answer enters.
  const landed = data.url || targetUrl;
  const requested = new URL(targetUrl);
  // The same-site policy check, with no DNS check: this rung never dials the landing host, the render
  // service did. Off-domain, cross-port, credentialed and http-downgrade landings all refuse.
  assertRedirectUrlAllowedForHost(requested.hostname, requested.port || '', landed);

  return {
    url: landed,
    status: data.status ?? 200,
    html: data.html,
    contentType: data.contentType || 'text/html',
  };
}
