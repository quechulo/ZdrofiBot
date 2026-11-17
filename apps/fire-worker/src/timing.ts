import crypto from "node:crypto";
import { setImmediate, setTimeout } from "node:timers/promises";

/** setTimeout can be late by a few ms, so the last stretch is spun. */
const SPIN_MS = 20;

/** Waits until a wall-clock time. Resolves at once if it has passed. */
export async function sleepUntil(at: number, signal?: AbortSignal): Promise<void> {
  const wait = at - Date.now();
  if (wait > 0) await setTimeout(wait, undefined, signal ? { signal } : {});
}

/** Like sleepUntil, but to within about a millisecond. Only for the send itself. */
export async function preciseSleepUntil(at: number): Promise<void> {
  const coarse = at - Date.now() - SPIN_MS;
  if (coarse > 0) await setTimeout(coarse);
  while (Date.now() < at) {
    if (at - Date.now() > 2) await setImmediate();
  }
}

export function shuffle<T>(items: T[]): T[] {
  const copy = [...items];
  for (let index = copy.length - 1; index > 0; index--) {
    const other = crypto.randomInt(index + 1);
    [copy[index], copy[other]] = [copy[other]!, copy[index]!];
  }
  return copy;
}

/**
 * Releases everyone waiting for the same moment together, in a new random order
 * each time, so no user is always first when several want the same class.
 */
export class FireBarrier {
  private readonly groups = new Map<number, Array<() => void>>();

  wait(at: number): Promise<void> {
    if (at <= Date.now()) return Promise.resolve();
    let waiters = this.groups.get(at);
    if (!waiters) {
      const group: Array<() => void> = [];
      waiters = group;
      this.groups.set(at, group);
      void preciseSleepUntil(at).then(() => {
        this.groups.delete(at);
        for (const release of shuffle(group)) release();
      });
    }
    const group = waiters;
    return new Promise((resolve) => group.push(resolve));
  }
}
