import { notifications, portalAccounts, portalActivities, registrationJobs, type AnyDatabase } from "@zdrofibot/db";
import { PORTAL_TIME_ZONE } from "@zdrofibot/scheduling";
import type { SessionVault } from "@zdrofibot/sessions";
import { and, asc, eq, gt, inArray, like, lte } from "drizzle-orm";
import type { KeepAlive } from "./keep-alive.js";
import type { Log } from "./log.js";
import type { Notifier, OutgoingMessage } from "./telegram/notifier.js";

/** Minutes before opening. Each is sent once, and only while the problem lasts. */
export const RUNGS = [60, 30, 15, 10, 5] as const;
const RESOLVED = "resolved";
/** A session checked this recently is trusted without another request. */
const FRESH_MS = 10 * 60_000;

interface Upcoming {
  jobId: string;
  userId: string;
  accountId: string;
  opensAt: Date;
  startsAt: Date;
  name: string;
}

const formatClassTime = new Intl.DateTimeFormat("en-GB", {
  timeZone: PORTAL_TIME_ZONE,
  weekday: "short",
  day: "numeric",
  month: "short",
  hour: "2-digit",
  minute: "2-digit",
});

export interface LadderOptions {
  /** Assisted login's page, once it exists (M4). */
  reconnectUrl: string | null;
}

/**
 * Checks every minute whether each account's next job, within the hour, has a
 * working session. If not, alerts at T-60, 30, 15, 10 and 5. A problem found
 * mid-ladder alerts at once. When it's fixed, one "all good" follows.
 */
export class AlertLadder {
  constructor(
    private readonly db: AnyDatabase,
    private readonly vault: SessionVault,
    private readonly keepAlive: KeepAlive,
    private readonly notifier: Notifier,
    private readonly options: LadderOptions,
    private readonly log: Log,
  ) {}

  async run(now = new Date()): Promise<void> {
    const rows = await this.db
      .select({
        jobId: registrationJobs.id,
        userId: registrationJobs.userId,
        accountId: portalAccounts.id,
        opensAt: registrationJobs.opensAt,
        startsAt: portalActivities.startsAt,
        name: portalActivities.name,
      })
      .from(registrationJobs)
      .innerJoin(portalAccounts, eq(portalAccounts.userId, registrationJobs.userId))
      .innerJoin(portalActivities, eq(portalActivities.id, registrationJobs.portalActivityId))
      .where(
        and(
          inArray(registrationJobs.state, ["SCHEDULED", "ARMED"]),
          gt(registrationJobs.opensAt, now),
          lte(registrationJobs.opensAt, new Date(now.getTime() + RUNGS[0] * 60_000)),
        ),
      )
      .orderBy(asc(registrationJobs.opensAt));

    // One ladder per account, keyed to its next job.
    const next = new Map<string, Upcoming>();
    for (const row of rows) if (!next.has(row.accountId)) next.set(row.accountId, row);
    for (const job of next.values()) await this.handle(job, now);
  }

  private async handle(job: Upcoming, now: Date): Promise<void> {
    const minutesLeft = (job.opensAt.getTime() - now.getTime()) / 60_000;
    const due = RUNGS.filter((rung) => minutesLeft <= rung).at(-1);
    if (due === undefined) return;
    if (await this.isHealthy(job.accountId, now)) {
      await this.resolve(job);
    } else {
      await this.alert(job, `T-${due}`, minutesLeft);
    }
  }

  private async isHealthy(accountId: string, now: Date): Promise<boolean> {
    const status = await this.vault.sessionStatus(accountId);
    if (status?.state !== "ACTIVE") return false;
    if (status.lastOkAt && now.getTime() - status.lastOkAt.getTime() < FRESH_MS) return true;
    // Busy means armed, and an unreachable portal says nothing about the session: neither is the user's to fix.
    return (await this.keepAlive.checkAccount(accountId, now)) !== "ended";
  }

  /** Inserts the rung first, so a restart can't send it twice. A failed send frees it for the next minute. */
  private async sendOnce(job: Upcoming, rung: string, message: OutgoingMessage): Promise<void> {
    const [claimed] = await this.db
      .insert(notifications)
      .values({ portalAccountId: job.accountId, jobId: job.jobId, rung, channel: this.notifier.channel })
      .onConflictDoNothing()
      .returning({ id: notifications.id });
    if (!claimed) return;
    const result = await this.notifier.send(job.userId, message);
    if (result === "failed") {
      await this.db.delete(notifications).where(eq(notifications.id, claimed.id));
      return;
    }
    if (result === "no-channel") this.log.warn(`User ${job.userId} has no alert channel. ${rung}: ${message.text}`);
  }

  private async alert(job: Upcoming, rung: string, minutesLeft: number): Promise<void> {
    const minutes = Math.max(1, Math.round(minutesLeft));
    const login = this.options.reconnectUrl
      ? "Tap Reconnect to log in again."
      : "Log in with recon/login.mjs, then run the import-session command.";
    await this.sendOnce(job, rung, {
      text: `⚠️ ${job.name}, ${formatClassTime.format(job.startsAt)}: registration opens in ${minutes} min, but the portal session has ended. ${login}`,
      ...(this.options.reconnectUrl ? { button: { text: "Reconnect", url: this.options.reconnectUrl } } : {}),
    });
  }

  private async resolve(job: Upcoming): Promise<void> {
    const alerted = await this.db
      .select({ rung: notifications.rung })
      .from(notifications)
      .where(and(eq(notifications.jobId, job.jobId), like(notifications.rung, "T-%")))
      .limit(1);
    if (alerted.length === 0) return;
    await this.sendOnce(job, RESOLVED, {
      text: `✅ All good: the session works again, and ${job.name}, ${formatClassTime.format(job.startsAt)} will be booked as planned.`,
    });
  }
}
