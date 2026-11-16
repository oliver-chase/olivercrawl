/** Sets `key` as the newest entry, first dropping the oldest when the map already holds `max`, so it stays bounded. */
export function rememberBounded<K, V>(map: Map<K, V>, key: K, value: V, max: number): void {
  map.delete(key);
  if (map.size >= max) {
    // Maps iterate in insertion order, so the first key is the oldest.
    const oldest = map.keys().next().value;
    if (oldest !== undefined) map.delete(oldest);
  }
  map.set(key, value);
}
