/**
 * Retry of a failed read of the working tree: a git lock held for a moment or a repo being rewritten passes by itself, so
 * the read is tried again a few times before the user has to press "Retry". A newer read (an event, the Retry button)
 * takes over: its turn is checked when the timer fires.
 */

export const RETRY_MS = 2000;
export const MAX_RETRIES = 3;

export interface Retrier {
  /** Plans `run(attempt + 1)` after the delay when `attempt` is below the limit. The run is skipped when `isCurrent()` is false by then. */
  schedule: (attempt: number, isCurrent: () => boolean, run: (attempt: number) => void) => boolean;
  /** Drops every planned retry (the view goes away). */
  cancelAll: () => void;
}

export function createRetrier(delayMs = RETRY_MS, max = MAX_RETRIES): Retrier {
  const timers = new Set<ReturnType<typeof setTimeout>>();
  return {
    schedule(attempt, isCurrent, run) {
      if (attempt >= max) return false;
      const t = setTimeout(() => {
        timers.delete(t);
        if (isCurrent()) run(attempt + 1);
      }, delayMs);
      timers.add(t);
      return true;
    },
    cancelAll() {
      timers.forEach(clearTimeout);
      timers.clear();
    },
  };
}
