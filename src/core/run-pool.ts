/**
 * Runs `fn` over every item with at most `width` calls in flight, each worker taking the next item when it
 * finishes one, so memory and in-flight requests stay bounded however many items there are.
 */
export async function runPool<T>(items: readonly T[], width: number, fn: (item: T, index: number) => Promise<void>): Promise<void> {
  let cursor = 0;
  const worker = async () => {
    while (cursor < items.length) {
      const index = cursor++;
      await fn(items[index]!, index);
    }
  };
  await Promise.all(Array.from({ length: Math.min(Math.max(1, Math.floor(width)), items.length) }, worker));
}
