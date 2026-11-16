import { describe, expect, test, vi } from 'vitest';
import { fetchViaJina } from '@/fetch/jina-fetch';

// TIMEOUT-JINA-1: a caller's timeout must bind on THIS rung too.
//
// It used its own hardcoded 30s and ignored `timeoutMs` entirely, so a consumer
// bounding a crawl at 8 seconds still waited up to 30 here. The bound read as a
// guarantee and was not one — and a caller cannot see which rung is running, so
// the one number they set has to mean something on every rung.

describe('the Jina rung honours the caller timeout', () => {
  test('aborts at the caller budget', async () => {
    const started = Date.now();
    const neverResolves: typeof fetch = ((_url: RequestInfo | URL, init?: RequestInit) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new Error('aborted')));
      })) as typeof fetch;

    const result = await fetchViaJina('https://site.example.com/x', {
      fetchImpl: neverResolves,
      timeoutMs: 150,
    });
    const elapsed = Date.now() - started;

    expect(result).toBeNull();
    // Well under the 30s default. Generous upper bound so this cannot flake on
    // a loaded machine while still failing outright if the default is used.
    expect(elapsed).toBeLessThan(5_000);
  });

  test('a caller that sets nothing is cut off at the rung default of 30 seconds', async () => {
    // Fake timers do not drive AbortSignal.timeout, so the bound is read where it is set.
    const timeout = vi.spyOn(AbortSignal, 'timeout');
    const never = ((_url: string, init?: RequestInit) =>
      new Promise((_resolve, reject) => init?.signal?.addEventListener('abort', () => reject(new Error('aborted'))))) as unknown as typeof fetch;
    const pending = fetchViaJina('https://site.example.com/x', { fetchImpl: never });
    expect(timeout).toHaveBeenCalledWith(30_000);
    timeout.mock.results[0]!.value.dispatchEvent(new Event('abort'));
    expect(await pending).toBeNull();
  });

});
