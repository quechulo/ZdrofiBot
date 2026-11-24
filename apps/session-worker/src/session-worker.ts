import { PORTAL_TIME_ZONE } from "@zdrofibot/scheduling";
import type { PgBoss } from "pg-boss";
import { describeError, type Log } from "./log.js";
import type { TelegramLinker } from "./telegram/linker.js";

export interface ScheduledTask {
  name: string;
  /** Five-field cron, in Warsaw time. pg-boss cron has one-minute resolution. */
  cron: string;
  run: () => Promise<unknown>;
  /** Also run once at startup, so a fresh start doesn't wait for the first slot. */
  onBoot?: boolean;
}

/**
 * Periodic work through pg-boss, so a schedule fires once even if a second
 * worker ever runs, and survives restarts. The fire path never goes through pg-boss.
 */
export class SessionWorker {
  private readonly polling = new AbortController();
  private pollingDone: Promise<void> | undefined;

  constructor(
    private readonly boss: PgBoss,
    private readonly tasks: ScheduledTask[],
    private readonly linker: TelegramLinker | null,
    private readonly log: Log,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    await this.start();
  }

  async beforeApplicationShutdown(): Promise<void> {
    await this.stop();
  }

  private async runTask(task: ScheduledTask): Promise<void> {
    try {
      await task.run();
    } catch (error) {
      this.log.error(`${task.name} failed: ${describeError(error)}`);
    }
  }

  async start(): Promise<void> {
    this.boss.on("error", (error) => this.log.error(`pg-boss: ${describeError(error)}`));
    await this.boss.start();
    for (const task of this.tasks) {
      // One run at a time per task. Each derives its work from table state, so nothing needs cancelling.
      await this.boss.createQueue(task.name, { policy: "singleton", retryLimit: 0, expireInSeconds: 15 * 60 });
      await this.boss.schedule(task.name, task.cron, null, { tz: PORTAL_TIME_ZONE });
      await this.boss.work(task.name, { pollingIntervalSeconds: 2 }, () => this.runTask(task));
    }
    void (async () => {
      for (const task of this.tasks.filter((candidate) => candidate.onBoot)) await this.runTask(task);
    })();
    if (this.linker) this.pollingDone = this.linker.poll(this.polling.signal);
    this.log.log(`Scheduled ${this.tasks.map((task) => `${task.name} (${task.cron})`).join(", ")}`);
  }

  async stop(): Promise<void> {
    this.polling.abort();
    await this.pollingDone;
    await this.boss.stop({ graceful: true, timeout: 30_000 });
  }
}
