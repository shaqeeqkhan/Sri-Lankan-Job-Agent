import type { SourceContext, Truncation } from './types.ts';

/**
 * Run `fn` over `items` with at most `workers` in flight, and return the results in INPUT order,
 * whatever finishes first. First-wins dedup depends on this (ThreatHire `http.map_in_order`).
 * A rejection from `fn` rejects the whole call; catch inside `fn` to keep going.
 */
export async function mapInOrder<T, R>(
  items: readonly T[],
  fn: (item: T, index: number) => Promise<R>,
  workers: number,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  const n = Math.max(1, Math.min(Math.floor(workers) || 1, items.length));
  let next = 0;
  async function worker(): Promise<void> {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i], i);
    }
  }
  await Promise.all(Array.from({ length: n }, worker));
  return results;
}

/**
 * The per-source detail budget: at most `max_details` detail fetches, and none started after
 * `ctx.deadline`. Call `take()` before each detail fetch, for every remaining candidate (do not
 * break out of the loop), so `truncation()` can say how many were left for the next scan.
 */
export function detailBudget(ctx: SourceContext, clock: () => number = Date.now) {
  const cap = Math.max(0, ctx.source.max_details);
  let used = 0;
  let stop: Truncation['reason'] | null = null;
  let left = 0;
  return {
    take(): boolean {
      if (!stop && used >= cap) stop = 'max_details';
      if (!stop && ctx.deadline != null && clock() >= ctx.deadline) {
        stop = 'time';
        ctx.log(`${ctx.source.id}: time budget spent after ${used} detail page(s); the rest wait for the next scan`);
      }
      if (stop) {
        left++;
        return false;
      }
      used++;
      return true;
    },
    get used() {
      return used;
    },
    truncation(): Truncation | undefined {
      return stop && left > 0 ? { reason: stop, left } : undefined;
    },
  };
}
