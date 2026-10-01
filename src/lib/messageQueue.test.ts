import assert from "node:assert/strict";
import { test } from "node:test";
import { createMessageQueue } from "./messageQueue.ts";

// A job that waits until the test releases it, so concurrency can be observed deterministically.
function gate() {
  let release!: () => void;
  const done = new Promise<void>((resolve) => (release = resolve));
  return { release, done };
}

const tick = () => new Promise((resolve) => setImmediate(resolve));

test("never runs more than `concurrency` jobs at once, and drains everything", async () => {
  const queue = createMessageQueue({ concurrency: 2, maxQueued: 100 });
  let current = 0;
  let peak = 0;
  let finished = 0;
  for (let i = 0; i < 10; i++) {
    queue.enqueue(`device-${i}`, async () => {
      current++;
      peak = Math.max(peak, current);
      await tick();
      current--;
      finished++;
    });
  }
  await queue.idle();
  assert.equal(peak, 2);
  assert.equal(finished, 10);
  assert.equal(queue.size(), 0);
});

test("jobs with the same key run one at a time, in arrival order", async () => {
  const queue = createMessageQueue({ concurrency: 4, maxQueued: 100 });
  const order: number[] = [];
  let sameKeyRunning = 0;
  let sameKeyPeak = 0;
  for (let i = 0; i < 5; i++) {
    queue.enqueue("device-a", async () => {
      sameKeyRunning++;
      sameKeyPeak = Math.max(sameKeyPeak, sameKeyRunning);
      await tick();
      order.push(i);
      sameKeyRunning--;
    });
  }
  await queue.idle();
  assert.equal(sameKeyPeak, 1);
  assert.deepEqual(order, [0, 1, 2, 3, 4]);
});

test("a busy key does not block other keys", async () => {
  const queue = createMessageQueue({ concurrency: 2, maxQueued: 100 });
  const slow = gate();
  const ran: string[] = [];
  queue.enqueue("a", async () => {
    await slow.done;
    ran.push("a1");
  });
  queue.enqueue("a", async () => {
    ran.push("a2");
  });
  queue.enqueue("b", async () => {
    ran.push("b1");
  });
  await tick();
  assert.deepEqual(ran, ["b1"]);
  slow.release();
  await queue.idle();
  assert.deepEqual(ran, ["b1", "a1", "a2"]);
});

test("refuses new jobs once maxQueued are waiting", async () => {
  const queue = createMessageQueue({ concurrency: 1, maxQueued: 2 });
  const blocker = gate();
  assert.equal(
    queue.enqueue("x", () => blocker.done),
    true,
  );
  // The first job is running, not waiting, so two more fit in the queue.
  assert.equal(
    queue.enqueue("y", async () => {}),
    true,
  );
  assert.equal(
    queue.enqueue("z", async () => {}),
    true,
  );
  assert.equal(
    queue.enqueue("w", async () => {}),
    false,
  );
  assert.equal(queue.size(), 2);
  blocker.release();
  await queue.idle();
  assert.equal(queue.size(), 0);
});

test("a throwing job is logged and does not stop the drain", async (t) => {
  const errorMock = t.mock.method(console, "error", () => {});
  const queue = createMessageQueue({ concurrency: 1, maxQueued: 10 });
  let after = 0;
  queue.enqueue("a", async () => {
    throw new Error("boom");
  });
  queue.enqueue("a", async () => {
    after++;
  });
  await queue.idle();
  assert.equal(after, 1);
  assert.equal(errorMock.mock.callCount(), 1);
  assert.equal(errorMock.mock.calls[0]!.arguments[0], "[queue] job failed:");
});

test("idle() resolves immediately on an empty queue", async () => {
  const queue = createMessageQueue({ concurrency: 1, maxQueued: 1 });
  await queue.idle();
  assert.equal(queue.running(), 0);
});
