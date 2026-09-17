import { log } from "./logger.js";

// Tracks the background work the webhook starts after acking Twilio.
//
// That ack is deliberate - Twilio retries a slow response, and fetching a page
// plus two model calls is well past its patience - but it means the real work
// outlives the request that started it. Without something holding a count, a
// deploy kills that work halfway: the item is saved and never enriched, or the
// claim row is written and the message never processed at all.
class JobTracker {
  private running = 0;
  private waiters: Array<() => void> = [];

  async run(job: () => Promise<void>): Promise<void> {
    this.running += 1;
    try {
      await job();
    } finally {
      this.running -= 1;
      if (this.running === 0) {
        const waiting = this.waiters;
        this.waiters = [];
        for (const resolve of waiting) resolve();
      }
    }
  }

  get count(): number {
    return this.running;
  }

  // Resolves when everything in flight has finished, or when the deadline
  // passes - whichever comes first. A timeout is not a failure to handle so
  // much as a fact to record: the platform is going to kill this process
  // shortly regardless, and knowing what was still running is the useful part.
  async drain(timeoutMs: number): Promise<void> {
    if (this.running === 0) return;

    log.info({ running: this.running }, "Waiting for in-flight jobs to finish");

    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        log.warn({ running: this.running }, "Drain timed out; jobs still running were abandoned");
        resolve();
      }, timeoutMs);

      this.waiters.push(() => {
        clearTimeout(timer);
        resolve();
      });
    });
  }
}

export const inFlightJobs: JobTracker = new JobTracker();
