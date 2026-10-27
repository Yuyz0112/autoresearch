/** `work` over `items`, at most `limit` at a time, results in order. */
export async function inParallel<T, R>(
  items: T[],
  limit: number,
  work: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = Array.from({ length: items.length });
  let next = 0;
  const lanes = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const at = next++;
      results[at] = await work(items[at]!);
    }
  });
  await Promise.all(lanes);
  return results;
}
