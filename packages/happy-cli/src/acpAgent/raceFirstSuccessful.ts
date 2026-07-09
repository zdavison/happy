/**
 * Races several async "legs" and resolves with the first one that RESOLVES.
 * A leg that rejects can never win — its rejection is ignored unless every leg
 * rejects, in which case the last error is surfaced. When a winner is found,
 * each losing leg's optional `onLose` cleanup runs so nothing is left dangling
 * (e.g. cancelling a pending phone-permission request the loser owns).
 */
export interface Leg<T> {
  run: Promise<T>;
  /** Cleanup fired if this leg loses the race. Must not throw meaningfully. */
  onLose?: () => void;
}

export function raceFirstSuccessful<T>(legs: Leg<T>[]): Promise<T> {
  if (legs.length === 0) {
    return Promise.reject(new Error('raceFirstSuccessful: no legs to race'));
  }
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    let pending = legs.length;
    let lastError: unknown = new Error('raceFirstSuccessful: all legs rejected');

    legs.forEach((leg, index) => {
      leg.run.then(
        (value) => {
          if (settled) {
            return;
          }
          settled = true;
          resolve(value);
          for (let i = 0; i < legs.length; i++) {
            if (i === index) {
              continue;
            }
            try {
              legs[i].onLose?.();
            } catch {
              // best-effort cleanup
            }
          }
        },
        (error) => {
          lastError = error;
          pending -= 1;
          if (!settled && pending === 0) {
            reject(lastError);
          }
        },
      );
    });
  });
}
