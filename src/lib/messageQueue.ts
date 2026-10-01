// A bounded, keyed work queue for incoming MQTT messages. Pure (no Prisma, no env) so it can be tested alone.
//
// - At most `concurrency` jobs run at once, which bounds concurrent database load when the broker hands us a
//   burst (e.g. the backlog it held for our persistent session while the backend was restarting).
// - At most `maxQueued` jobs wait; past that enqueue() refuses, which bounds memory. That cap is the only point
//   where a message is dropped, and the caller logs it.
// - Jobs sharing a key (a device id) never run at the same time and start in arrival order. Ingest reads the
//   device row and then writes lastSeenAt/diagnostics from it, so two of one unit's messages running in parallel
//   could each read the same stale row and the older one could win the write. Serializing per device also means
//   one noisy unit can occupy at most one worker, leaving the others to the rest of the fleet.
export type MessageQueue = {
  enqueue(key: string, job: () => Promise<void>): boolean;
  size(): number;
  running(): number;
  idle(): Promise<void>;
};

type Entry = { key: string; job: () => Promise<void> };

export function createMessageQueue(options: { concurrency: number; maxQueued: number }): MessageQueue {
  const pending: Entry[] = [];
  const runningKeys = new Set<string>();
  let active = 0;
  let idleWaiters: Array<() => void> = [];

  const settleIdle = () => {
    if (active === 0 && pending.length === 0) {
      const waiters = idleWaiters;
      idleWaiters = [];
      for (const resolve of waiters) resolve();
    }
  };

  const pump = () => {
    while (active < options.concurrency) {
      const index = pending.findIndex((entry) => !runningKeys.has(entry.key));
      if (index === -1) break;
      const [entry] = pending.splice(index, 1);
      active++;
      runningKeys.add(entry!.key);
      // A job is expected to handle its own errors; this catch only keeps a stray rejection from stopping the
      // drain or crashing the process.
      Promise.resolve()
        .then(entry!.job)
        .catch((err) => console.error("[queue] job failed:", err))
        .finally(() => {
          active--;
          runningKeys.delete(entry!.key);
          pump();
          settleIdle();
        });
    }
  };

  return {
    enqueue(key, job) {
      if (pending.length >= options.maxQueued) return false;
      pending.push({ key, job });
      pump();
      return true;
    },
    size: () => pending.length,
    running: () => active,
    idle() {
      if (active === 0 && pending.length === 0) return Promise.resolve();
      return new Promise((resolve) => idleWaiters.push(resolve));
    },
  };
}
