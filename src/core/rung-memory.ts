// ─── Remember which rung actually works for a host ──────────────────────────
//
// BETTER-RUNGMEMORY-1: a host that always 403s the direct fetch and always
// succeeds on a later rung skips the wasted direct request on every page.
//
// Two rules keep it honest:
//
//   1. A remembered rung is a STARTING POINT, never a restriction. The full
//      ladder stays available beneath it, so a wrong memory costs one
//      request and never a failed crawl.
//   2. Memory expires. A site that stops blocking must not stay pinned to
//      the expensive rung forever, and blocking is frequently temporary.

/** How long a remembered rung is trusted before the ladder is re-probed. */
export const RUNG_MEMORY_TTL_MS = 30 * 60 * 1000; // 30 minutes

type Remembered = { rung: string; expiresAt: number };

/**
 * The store is created PER CRAWLER, never module-level: a different User-Agent
 * gets different answers from the same host, so a memory learned under one
 * identity is not evidence about another.
 */
export type RungMemory = Map<string, Remembered>;

export function createRungMemory(): RungMemory {
  return new Map();
}

/**
 * Record the rung that actually produced a page for this host.
 *
 * Only ever called on SUCCESS, so one bad minute never pins a host into a worse path than it needs.
 */
export function rememberWinningRung(memory: RungMemory, hostname: string, rung: string): void {
  memory.set(hostname.toLowerCase(), { rung, expiresAt: Date.now() + RUNG_MEMORY_TTL_MS });
}

/**
 * The rung that worked last time for this host, if the memory is still fresh.
 *
 * Returns null when nothing is remembered or it has expired — in which case
 * the caller simply starts at the top of the ladder as it always did.
 */
export function recallWinningRung(memory: RungMemory, hostname: string): string | null {
  const host = hostname.toLowerCase();
  const hit = memory.get(host);
  if (!hit) return null;
  if (Date.now() >= hit.expiresAt) {
    memory.delete(host);
    return null;
  }
  return hit.rung;
}

/**
 * Drop a host's memory after the remembered rung failed: the host has usually
 * changed, so the path being skipped may now be the one that works.
 */
export function forgetWinningRung(memory: RungMemory, hostname: string): void {
  memory.delete(hostname.toLowerCase());
}

/**
 * Should the direct fetch be skipped for this host?
 *
 * True only when a live memory says a LATER rung is what works. Deliberately
 * narrow — it reports that the cheap rung is known-useless here, and does not
 * try to select a rung.
 *
 * A caller that skips the fetch still has every recovery rung available, and
 * on failure must call `forgetWinningRung` and retry the normal path — that
 * pairing is what keeps a stale memory to one extra request and never a
 * lost page.
 */
export function shouldSkipDirectFetch(memory: RungMemory, hostname: string): boolean {
  const remembered = recallWinningRung(memory, hostname);
  return remembered !== null && remembered !== 'fetch';
}
