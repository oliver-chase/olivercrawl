// ─── Per-host throttle ──────────────────────────────────────────────────────
//
// A minimum gap between requests to the SAME host, process-wide and across
// concurrent callers, plus latency-based pacing and a per-host slot count.
// config-types.ts documents minHostIntervalMs and adaptiveThrottleMultiplier.

import { rememberBounded } from './bounded-map.js';

/** Hosts remembered per map. The oldest goes first, so a process that crawls many hosts stays bounded. */
const MAX_TRACKED_HOSTS = 10_000;

/** Serialised "next allowed time" per host. */
const NEXT_ALLOWED_AT = new Map<string, number>();

/** Rolling average response latency per host, for adaptive throttling: one exponential moving average per host. */
const AVG_LATENCY_MS = new Map<string, number>();

/** Weight of the newest sample. 0.3 = responsive to a change without one
 *  slow outlier dominating. */
const LATENCY_SMOOTHING = 0.3;

/**
 * CRAWL-PARALLEL-1: requests in flight per host, process-wide. The gap
 * above spaces requests out in time, and this caps how many overlap, so two
 * crawls that share an origin still count as one load on it.
 */
const IN_FLIGHT = new Map<string, number>();

/** Take one in-flight slot on a host, or report that the host is at its limit. */
export function tryAcquireHostSlot(hostname: string, limit: number): boolean {
  const host = hostname.toLowerCase();
  const held = IN_FLIGHT.get(host) ?? 0;
  if (held >= limit) return false;
  IN_FLIGHT.set(host, held + 1);
  return true;
}

export function releaseHostSlot(hostname: string): void {
  const host = hostname.toLowerCase();
  const held = (IN_FLIGHT.get(host) ?? 1) - 1;
  if (held <= 0) IN_FLIGHT.delete(host);
  else IN_FLIGHT.set(host, held);
}

/** Test seam. */
export function __clearThrottleForTests(): void {
  NEXT_ALLOWED_AT.clear();
  AVG_LATENCY_MS.clear();
  IN_FLIGHT.clear();
}

/** Record how long a host took to answer, for adaptive pacing. */
export function recordHostLatency(hostname: string, latencyMs: number): void {
  const host = hostname.toLowerCase();
  const prior = AVG_LATENCY_MS.get(host);
  const average = prior === undefined ? latencyMs : prior * (1 - LATENCY_SMOOTHING) + latencyMs * LATENCY_SMOOTHING;
  rememberBounded(AVG_LATENCY_MS, host, average, MAX_TRACKED_HOSTS);
}

/**
 * The gap to leave before the next request to this host.
 *
 * With adaptive pacing on, that is `avgLatency x multiplier` — a site that
 * answers in 100ms is polled briskly, one grinding at 3s is given room —
 * with the configured minimum as a floor so adaptive can only ever make the
 * crawler MORE polite, never less.
 */
export function intervalForHost(hostname: string, minIntervalMs: number, adaptiveMultiplier = 0): number {
  if (adaptiveMultiplier <= 0) return minIntervalMs;
  const avg = AVG_LATENCY_MS.get(hostname.toLowerCase());
  if (avg === undefined) return minIntervalMs;
  return Math.max(minIntervalMs, Math.round(avg * adaptiveMultiplier));
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Wait until this host is allowed another request, then reserve the next slot.
 *
 * The reservation is made BEFORE awaiting, so concurrent callers for the same
 * host queue behind each other, so they never all read the same "now" and
 * fire together — the bug a naive last-request-time check has.
 */
export async function throttleHost(hostname: string, minIntervalMs: number, adaptiveMultiplier = 0): Promise<void> {
  const interval = intervalForHost(hostname, minIntervalMs, adaptiveMultiplier);
  if (!interval || interval <= 0) return;

  const host = hostname.toLowerCase();
  const now = Date.now();
  const earliest = NEXT_ALLOWED_AT.get(host) ?? 0;
  const runAt = Math.max(now, earliest);

  // Reserve first — this is what makes concurrent callers serialise.
  rememberBounded(NEXT_ALLOWED_AT, host, runAt + interval, MAX_TRACKED_HOSTS);

  const waitMs = runAt - now;
  if (waitMs > 0) await sleep(waitMs);
}
