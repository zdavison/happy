import { describe, it, expect } from 'vitest';
import { raceFirstSuccessful } from './raceFirstSuccessful';

const tick = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('raceFirstSuccessful', () => {
  it('resolves with the first leg that resolves', async () => {
    const winner = await raceFirstSuccessful<string>([
      { run: tick(30).then(() => 'slow') },
      { run: tick(5).then(() => 'fast') },
    ]);
    expect(winner).toBe('fast');
  });

  it('ignores a rejecting leg and lets a later resolving leg win', async () => {
    const winner = await raceFirstSuccessful<string>([
      { run: Promise.reject(new Error('nope')) },
      { run: tick(5).then(() => 'ok') },
    ]);
    expect(winner).toBe('ok');
  });

  it('fires onLose for each losing leg once a winner is found', async () => {
    const lost: string[] = [];
    const winner = await raceFirstSuccessful<string>([
      { run: tick(5).then(() => 'winner'), onLose: () => lost.push('a') },
      { run: tick(50).then(() => 'loser'), onLose: () => lost.push('b') },
    ]);
    expect(winner).toBe('winner');
    // Give the losing leg a chance to settle; its onLose must have already fired.
    await tick(60);
    expect(lost).toEqual(['b']);
  });

  it('rejects with the last error when every leg rejects', async () => {
    await expect(
      raceFirstSuccessful<string>([
        { run: Promise.reject(new Error('first')) },
        { run: tick(5).then(() => Promise.reject(new Error('last'))) },
      ]),
    ).rejects.toThrow('last');
  });

  it('rejects when given no legs', async () => {
    await expect(raceFirstSuccessful([])).rejects.toThrow('no legs');
  });
});
