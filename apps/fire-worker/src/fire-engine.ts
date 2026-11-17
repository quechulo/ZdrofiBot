import { monitorEventLoopDelay } from "node:perf_hooks";
import type { SessionVault } from "@zdrofibot/sessions";
import type { FireTimings } from "./config.js";
import { FireRunner, type Log, type RunnerDeps, type RunnerMode } from "./fire-runner.js";
import type { ClaimedJob, JobStore } from "./job-store.js";
import { FireBarrier } from "./timing.js";

export interface FireEngineDeps {
  store: JobStore;
  vault: SessionVault;
  timings: FireTimings;
  portalOrigin: string;
  userAgent: string;
  log: Log;
}

const describe = (error: unknown) => (error instanceof Error ? `${error.name}: ${error.message}` : "unknown error");

/**
 * Claims due jobs every 30 s and runs each one. pg-boss stays out of this path:
 * its cron has one-minute resolution and its polling adds seconds.
 */
export class FireEngine {
  private readonly runners = new Map<string, FireRunner>();
  private readonly runnerDeps: RunnerDeps;
  private readonly loopDelay = monitorEventLoopDelay({ resolution: 10 });
  private armTimer: NodeJS.Timeout | undefined;
  private renewTimer: NodeJS.Timeout | undefined;
  private arming: Promise<void> | undefined;
  private booted = false;
  private stopping = false;

  constructor(private readonly deps: FireEngineDeps) {
    this.runnerDeps = { ...deps, barrier: new FireBarrier(), loopDelay: this.loopDelay };
  }

  /** Called by Nest once the app is ready. */
  onApplicationBootstrap(): void {
    this.start();
  }

  /** Called by Nest on SIGTERM, before the database pool closes. */
  async beforeApplicationShutdown(): Promise<void> {
    await this.stop();
  }

  start(): void {
    this.loopDelay.enable();
    void this.tick();
    this.armTimer = setInterval(() => void this.tick(), this.deps.timings.armIntervalMs);
    this.renewTimer = setInterval(() => void this.renew(), this.deps.timings.renewIntervalMs);
  }

  /** Jobs this worker is running now. */
  get active(): ReadonlyMap<string, FireRunner> {
    return this.runners;
  }

  tick(): Promise<void> {
    // One claim at a time, or a slow query would let two overlap.
    this.arming ??= this.claim().finally(() => {
      this.arming = undefined;
    });
    return this.arming;
  }

  private async claim(): Promise<void> {
    if (this.stopping) return;
    const { store, timings } = this.deps;
    try {
      const now = new Date();
      const onBoot = !this.booted;
      const missed = await store.markMissed(now, timings.lateLimitMs);
      if (missed > 0) this.deps.log.warn(`${missed} job(s) found too late and marked MISSED`);
      const interrupted = await store.claimInterrupted(now, onBoot);
      const due = await store.claimDue(now, timings.armLeadMs, timings.lateLimitMs, onBoot);
      this.booted = true;
      for (const job of interrupted) this.spawn(job, "recover");
      for (const job of due) this.spawn(job, "fire");
    } catch (error) {
      this.deps.log.error(`Claiming failed: ${describe(error)}`);
    }
  }

  private spawn(job: ClaimedJob, mode: RunnerMode): void {
    if (this.runners.has(job.id) || this.stopping) return;
    const runner = new FireRunner(job, mode, this.runnerDeps);
    this.runners.set(job.id, runner);
    void runner.done.finally(() => this.runners.delete(job.id));
    this.deps.log.log(`Job ${job.id} ${mode === "fire" ? "armed" : "recovering"}, opens ${job.opensAt.toISOString()}`);
  }

  private async renew(): Promise<void> {
    const now = Date.now();
    // Nothing else talks to the database right around a send.
    if ([...this.runners.values()].some((runner) => runner.isQuiet(now))) return;
    try {
      await this.deps.store.renew([...this.runners.keys()], new Date(now));
      await this.deps.store.heartbeat(new Date(now));
    } catch (error) {
      this.deps.log.error(`Lease renewal failed: ${describe(error)}`);
    }
  }

  /**
   * Hands back jobs that are far enough away for another worker, and finishes
   * the rest. Leases keep being renewed until the last one is done.
   */
  async stop(): Promise<void> {
    if (this.stopping) return;
    this.stopping = true;
    clearInterval(this.armTimer);
    await this.arming;
    const keepFrom = Date.now() + this.deps.timings.drainKeepMs;
    const runners = [...this.runners.values()];
    const released = runners.filter((runner) => runner.job.opensAt.getTime() > keepFrom && runner.release());
    const finishing = runners.length - released.length;
    if (runners.length > 0) this.deps.log.log(`Stopping: handing back ${released.length} job(s), finishing ${finishing}`);
    await Promise.all(runners.map((runner) => runner.done));
    clearInterval(this.renewTimer);
    this.loopDelay.disable();
  }
}
