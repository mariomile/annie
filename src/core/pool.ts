/**
 * Run `work` on every item, at most `limit` at a time, results in the items' order. After a
 * failure no new item starts, and the first error is the result once the running ones settle.
 */
export async function pool<T, R>(items: readonly T[], limit: number, work: (item: T, index: number) => Promise<R>): Promise<R[]> {
	const results: R[] = new Array(items.length);
	let next = 0;
	let failed = false;
	const lane = async () => {
		while (next < items.length && !failed) {
			const i = next++;
			try {
				results[i] = await work(items[i] as T, i);
			} catch (error) {
				failed = true;
				throw error;
			}
		}
	};
	const lanes = await Promise.allSettled(Array.from({ length: Math.min(limit, items.length) }, lane));
	const rejected = lanes.find((l): l is PromiseRejectedResult => l.status === "rejected");
	if (rejected !== undefined) throw rejected.reason;
	return results;
}
