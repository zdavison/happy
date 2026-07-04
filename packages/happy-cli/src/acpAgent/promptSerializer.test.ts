import { describe, it, expect, vi } from 'vitest';
import { createPromptSerializer } from './promptSerializer';

/** A promise plus its externally-callable resolve/reject, for controlling timing by hand. */
function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void; reject: (e: unknown) => void } {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe('createPromptSerializer', () => {
  it('does not start the second call until the first settles (one turn in flight)', async () => {
    const d1 = deferred<string>();
    const d2 = deferred<string>();
    const run = vi.fn((params: string) => (params === 'first' ? d1.promise : d2.promise));
    const serialized = createPromptSerializer(run);

    const p1 = serialized('first');
    const p2 = serialized('second');

    // Second call must not invoke `run` while the first is still in flight.
    await Promise.resolve();
    await Promise.resolve();
    expect(run).toHaveBeenCalledTimes(1);
    expect(run).toHaveBeenCalledWith('first');

    d1.resolve('done-first');
    expect(await p1).toBe('done-first');

    // Now that the first has settled, the second should have been started.
    await Promise.resolve();
    expect(run).toHaveBeenCalledTimes(2);
    expect(run).toHaveBeenCalledWith('second');

    d2.resolve('done-second');
    expect(await p2).toBe('done-second');
  });

  it('lets the next call run even if the previous one rejects', async () => {
    const d1 = deferred<string>();
    const d2 = deferred<string>();
    const run = vi.fn((params: string) => (params === 'first' ? d1.promise : d2.promise));
    const serialized = createPromptSerializer(run);

    const p1 = serialized('first');
    const p2 = serialized('second');

    d1.reject(new Error('boom'));
    await expect(p1).rejects.toThrow('boom');

    // A prior rejection must not block the next call from starting.
    await Promise.resolve();
    expect(run).toHaveBeenCalledTimes(2);

    d2.resolve('done-second');
    expect(await p2).toBe('done-second');
  });

  it('runs calls made truly sequentially in order, one at a time', async () => {
    const order: string[] = [];
    const run = vi.fn(async (params: number) => {
      order.push(`start:${params}`);
      await new Promise((r) => setTimeout(r, 5));
      order.push(`end:${params}`);
      return params * 2;
    });
    const serialized = createPromptSerializer(run);

    const results = await Promise.all([serialized(1), serialized(2), serialized(3)]);

    expect(results).toEqual([2, 4, 6]);
    expect(order).toEqual(['start:1', 'end:1', 'start:2', 'end:2', 'start:3', 'end:3']);
  });
});
