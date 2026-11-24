import { portalAccounts, portalSessions, registrationJobs, type AnyDatabase } from "@zdrofibot/db";
import { PortalClient, PortalCookieJar, type SessionState } from "@zdrofibot/portal";
import type { SessionVault } from "@zdrofibot/sessions";
import { and, eq, inArray } from "drizzle-orm";
import { describeError, type Log } from "./log.js";

export interface KeepAliveOptions {
  portalOrigin: string;
  userAgent: string;
}

export type CheckOutcome = "alive" | "ended" | "unreachable" | "busy" | "no-session";

/** States in which the fire worker owns the session's cookies. */
const FIRING_STATES = ["ARMED", "FIRING", "VERIFYING"] as const;

/**
 * Polls each live session so it doesn't hit the idle timeout (somewhere between
 * 2h54m and about 4 days). Every check also tells whether the session is still
 * logged in, and a death is recorded with its lifetime.
 */
export class KeepAlive {
  constructor(
    private readonly db: AnyDatabase,
    private readonly vault: SessionVault,
    private readonly options: KeepAliveOptions,
    private readonly log: Log,
  ) {}

  async run(now = new Date()): Promise<Record<CheckOutcome, number>> {
    const accounts = await this.db
      .select({ id: portalAccounts.id })
      .from(portalAccounts)
      .innerJoin(portalSessions, eq(portalSessions.portalAccountId, portalAccounts.id))
      .where(inArray(portalSessions.state, ["ACTIVE", "REFRESHING"]));
    const counts: Record<CheckOutcome, number> = { alive: 0, ended: 0, unreachable: 0, busy: 0, "no-session": 0 };
    for (const account of accounts) counts[await this.checkAccount(account.id, now)]++;
    if (accounts.length > 0) {
      this.log.log(
        `Keep-alive: ${Object.entries(counts)
          .filter(([, count]) => count > 0)
          .map(([outcome, count]) => `${count} ${outcome}`)
          .join(", ")}`,
      );
    }
    return counts;
  }

  /**
   * Skipped while a job is armed: the fire worker may be rotating the same
   * cookies, and two writers would race.
   */
  async isBusy(accountId: string): Promise<boolean> {
    const rows = await this.db
      .select({ id: registrationJobs.id })
      .from(registrationJobs)
      .innerJoin(portalAccounts, eq(portalAccounts.userId, registrationJobs.userId))
      .where(and(eq(portalAccounts.id, accountId), inArray(registrationJobs.state, [...FIRING_STATES])))
      .limit(1);
    return rows.length > 0;
  }

  async checkAccount(accountId: string, now = new Date()): Promise<CheckOutcome> {
    if (await this.isBusy(accountId)) return "busy";
    const session = await this.vault.loadSession(accountId);
    if (!session) return "no-session";

    const jar = new PortalCookieJar(new URL(this.options.portalOrigin).hostname, session.state);
    const before = JSON.stringify(jar.toState());
    const client = new PortalClient({ userAgent: this.options.userAgent, origin: this.options.portalOrigin, jar });
    let state: SessionState;
    try {
      state = await client.checkSession();
    } catch (error) {
      this.log.warn(`Keep-alive for account ${accountId}: ${describeError(error)}`);
      await this.vault.markCheckFailed(accountId, now);
      return "unreachable";
    }

    if (state === "authenticated") {
      await this.vault.markOk(accountId, now);
      if (JSON.stringify(jar.toState()) !== before) {
        // A rotated SULUSESSID must be kept, or the next request sends a dead one.
        await this.vault.saveStorageState(accountId, jar.toState(), session.version);
      }
      return "alive";
    }
    if (state === "logged-out") {
      if (await this.vault.markEnded(accountId, session.version, now, "keep-alive")) {
        this.log.warn(`Session for account ${accountId} has ended`);
      }
      return "ended";
    }
    await this.vault.markCheckFailed(accountId, now);
    return "unreachable";
  }
}
