import { portalActivities, registrationJobs, workerHeartbeats, type AnyDatabase } from "@zdrofibot/db";
import type { JobState } from "@zdrofibot/scheduling";
import { and, asc, eq, gt, inArray, isNull, lt, lte, ne, or, sql, type SQL } from "drizzle-orm";

export interface ClaimedJob {
  id: string;
  userId: string;
  portalActivityId: number;
  clubSlug: string;
  opensAt: Date;
  state: JobState;
}

export type FinalState = Extract<JobState, "BOOKED" | "WAITLISTED" | "FULL" | "FAILED" | "MISSED">;

export interface JobResult {
  state: FinalState;
  errorCode?: string;
  sentAt?: Date;
  confirmedAt?: Date;
  /** Left out by a recovery check, which doesn't know how many were sent. */
  postsSent?: number;
}

export interface TokenSource {
  id: number;
  clubSlug: string;
}

const CLAIM_BATCH = 50;
const jobs = registrationJobs;

/** Every write is conditional on this worker still owning the job. */
export class JobStore {
  constructor(
    private readonly db: AnyDatabase,
    private readonly workerId: string,
    private readonly leaseMs: number,
  ) {}

  private owned(id: string): SQL {
    return and(eq(jobs.id, id), eq(jobs.workerId, this.workerId))!;
  }

  private leaseExpired(now: Date, onBoot: boolean): SQL {
    // On boot, our own leases are stale too: whatever held them died with the old process.
    const expired = or(isNull(jobs.leaseUntil), lt(jobs.leaseUntil, now))!;
    return onBoot ? or(expired, eq(jobs.workerId, this.workerId))! : expired;
  }

  /** Jobs nobody fired in time. Never fires them. */
  async markMissed(now: Date, lateLimitMs: number): Promise<number> {
    const rows = await this.db
      .update(jobs)
      .set({ state: "MISSED", errorCode: "late", workerId: null, leaseUntil: null, updatedAt: now })
      .where(
        and(
          lt(jobs.opensAt, new Date(now.getTime() - lateLimitMs)),
          or(eq(jobs.state, "SCHEDULED"), and(eq(jobs.state, "ARMED"), this.leaseExpired(now, false))),
        ),
      )
      .returning({ id: jobs.id });
    return rows.length;
  }

  private async claim(where: SQL, state: JobState, now: Date): Promise<ClaimedJob[]> {
    const claimed = await this.db.transaction(async (tx) => {
      const due = await tx
        .select({ id: jobs.id })
        .from(jobs)
        .where(where)
        .orderBy(asc(jobs.opensAt))
        .limit(CLAIM_BATCH)
        .for("update", { skipLocked: true });
      if (due.length === 0) return [];
      return tx
        .update(jobs)
        .set({ state, workerId: this.workerId, leaseUntil: new Date(now.getTime() + this.leaseMs), updatedAt: now })
        .where(inArray(jobs.id, due.map((row) => row.id)))
        .returning({ id: jobs.id });
    });
    if (claimed.length === 0) return [];
    return this.db
      .select({
        id: jobs.id,
        userId: jobs.userId,
        portalActivityId: jobs.portalActivityId,
        clubSlug: portalActivities.clubSlug,
        opensAt: jobs.opensAt,
        state: jobs.state,
      })
      .from(jobs)
      .innerJoin(portalActivities, eq(portalActivities.id, jobs.portalActivityId))
      .where(inArray(jobs.id, claimed.map((row) => row.id)))
      .orderBy(asc(jobs.opensAt));
  }

  /** Scheduled jobs due within the lead, and armed ones whose worker died. */
  claimDue(now: Date, armLeadMs: number, lateLimitMs: number, onBoot: boolean): Promise<ClaimedJob[]> {
    const window = and(
      lte(jobs.opensAt, new Date(now.getTime() + armLeadMs)),
      gt(jobs.opensAt, new Date(now.getTime() - lateLimitMs)),
    );
    const claimable = or(eq(jobs.state, "SCHEDULED"), and(eq(jobs.state, "ARMED"), this.leaseExpired(now, onBoot)));
    return this.claim(and(window, claimable)!, "ARMED", now);
  }

  /** Jobs whose worker died mid-fire. They are only ever checked, never fired again. */
  claimInterrupted(now: Date, onBoot: boolean): Promise<ClaimedJob[]> {
    const interrupted = and(inArray(jobs.state, ["FIRING", "VERIFYING"]), this.leaseExpired(now, onBoot))!;
    return this.claim(interrupted, "VERIFYING", now);
  }

  async renew(ids: string[], now: Date): Promise<void> {
    if (ids.length === 0) return;
    const until = new Date(now.getTime() + this.leaseMs);
    await this.db
      .update(jobs)
      // GREATEST, so renewing never shortens the longer lease FIRING sets.
      .set({ leaseUntil: sql`greatest(${jobs.leaseUntil}, ${until.toISOString()}::timestamptz)` })
      .where(
        and(
          inArray(jobs.id, ids),
          eq(jobs.workerId, this.workerId),
          inArray(jobs.state, ["ARMED", "FIRING", "VERIFYING"]),
        ),
      );
  }

  /**
   * The last write before sending. False if the job was cancelled, moved or
   * taken in the meantime, and then nothing may be sent.
   */
  async markFiring(job: ClaimedJob, leaseUntil: Date, now: Date): Promise<boolean> {
    const rows = await this.db
      .update(jobs)
      .set({ state: "FIRING", leaseUntil, updatedAt: now })
      .where(and(this.owned(job.id), eq(jobs.state, "ARMED"), eq(jobs.opensAt, job.opensAt)))
      .returning({ id: jobs.id });
    return rows.length === 1;
  }

  async markVerifying(id: string, now: Date): Promise<void> {
    await this.db
      .update(jobs)
      .set({ state: "VERIFYING", updatedAt: now })
      .where(and(this.owned(id), eq(jobs.state, "FIRING")));
  }

  /** Hands an armed job back, for a shutdown or a moved opening time. */
  async release(id: string, now: Date): Promise<void> {
    await this.db
      .update(jobs)
      .set({ state: "SCHEDULED", workerId: null, leaseUntil: null, updatedAt: now })
      .where(and(this.owned(id), eq(jobs.state, "ARMED")));
  }

  async finish(job: ClaimedJob, result: JobResult, now: Date): Promise<void> {
    await this.db
      .update(jobs)
      .set({
        state: result.state,
        errorCode: result.errorCode ?? null,
        workerId: null,
        leaseUntil: null,
        updatedAt: now,
        ...(result.sentAt
          ? { sentAt: result.sentAt, sendLatencyMs: result.sentAt.getTime() - job.opensAt.getTime() }
          : {}),
        ...(result.confirmedAt ? { confirmedAt: result.confirmedAt } : {}),
        ...(result.postsSent === undefined ? {} : { postsSent: result.postsSent }),
      })
      .where(and(this.owned(job.id), ne(jobs.state, "CANCELLED")));
  }

  /**
   * Classes open now that stay open for a while. Any of them yields the
   * session-wide token, so a single POST can go out at T. The target's club first.
   */
  tokenSources(job: ClaimedJob, now: Date, limit = 3): Promise<TokenSource[]> {
    return this.db
      .select({ id: portalActivities.id, clubSlug: portalActivities.clubSlug })
      .from(portalActivities)
      .where(
        and(
          eq(portalActivities.window, "open"),
          lte(portalActivities.opensAt, now),
          gt(portalActivities.startsAt, new Date(now.getTime() + 60 * 60_000)),
          ne(portalActivities.id, job.portalActivityId),
        ),
      )
      .orderBy(sql`${portalActivities.clubSlug} <> ${job.clubSlug}`, asc(portalActivities.startsAt))
      .limit(limit);
  }

  async heartbeat(now: Date): Promise<void> {
    await this.db
      .insert(workerHeartbeats)
      .values({ worker: this.workerId, beatAt: now })
      .onConflictDoUpdate({ target: workerHeartbeats.worker, set: { beatAt: now } });
  }
}
