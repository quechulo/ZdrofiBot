import type { SecretBox } from "@zdrofibot/crypto";
import { portalAccounts, portalSessions, secretBlobs, sessionEnds, type AnyDatabase } from "@zdrofibot/db";
import type { StoredState } from "@zdrofibot/portal";
import { and, eq, sql } from "drizzle-orm";

export interface PortalAccount {
  id: string;
  userId: string;
  homeClubSlug: string;
}

/** A session's cookies, and the version to quote when writing them back. */
export interface StoredSession {
  state: StoredState;
  version: number;
}

export interface SessionStatus {
  state: (typeof portalSessions.state.enumValues)[number];
  loggedInAt: Date | null;
  lastOkAt: Date | null;
  failureCount: number;
}

type SecretKind = (typeof secretBlobs.kind.enumValues)[number];

/** Ties a secret to its row, so ciphertext copied elsewhere won't decrypt. */
const context = (accountId: string, kind: SecretKind) => `${accountId}:${kind}`;

/**
 * Reads and writes a portal account's encrypted secrets and session state.
 * Only the workers use this. The API can't read `secret_blobs`.
 *
 * Writes that follow a portal request quote the version they read, so cookies
 * from before a new login can never replace it.
 */
export class SessionVault {
  constructor(
    private readonly db: AnyDatabase,
    private readonly box: SecretBox,
  ) {}

  async accountForUser(userId: string): Promise<PortalAccount | null> {
    const [account] = await this.db
      .select({ id: portalAccounts.id, userId: portalAccounts.userId, homeClubSlug: portalAccounts.homeClubSlug })
      .from(portalAccounts)
      .where(eq(portalAccounts.userId, userId));
    return account ?? null;
  }

  async loadSession(accountId: string): Promise<StoredSession | null> {
    const kind = "storage_state";
    const [row] = await this.db
      .select()
      .from(secretBlobs)
      .where(and(eq(secretBlobs.portalAccountId, accountId), eq(secretBlobs.kind, kind)));
    if (!row) return null;
    const plaintext = await this.box.open(row, context(accountId, kind));
    return { state: JSON.parse(plaintext.toString("utf8")) as StoredState, version: row.version };
  }

  async loadStorageState(accountId: string): Promise<StoredState | null> {
    return (await this.loadSession(accountId))?.state ?? null;
  }

  /**
   * With `expectedVersion`, writes only if nobody has written since that read,
   * and returns false otherwise. Without it, always writes: that's for a new login.
   */
  async saveStorageState(accountId: string, state: StoredState, expectedVersion?: number): Promise<boolean> {
    const kind = "storage_state";
    const sealed = await this.box.seal(Buffer.from(JSON.stringify(state)), context(accountId, kind));
    const set = { ...sealed, version: sql`${secretBlobs.version} + 1`, updatedAt: sql`now()` };
    if (expectedVersion === undefined) {
      await this.db
        .insert(secretBlobs)
        .values({ portalAccountId: accountId, kind, ...sealed })
        .onConflictDoUpdate({ target: [secretBlobs.portalAccountId, secretBlobs.kind], set });
      return true;
    }
    const rows = await this.db
      .update(secretBlobs)
      .set(set)
      .where(
        and(
          eq(secretBlobs.portalAccountId, accountId),
          eq(secretBlobs.kind, kind),
          eq(secretBlobs.version, expectedVersion),
        ),
      )
      .returning({ version: secretBlobs.version });
    return rows.length === 1;
  }

  /** A fresh login: stores the cookies and marks the session active. */
  async storeLogin(accountId: string, state: StoredState, loggedInAt: Date): Promise<void> {
    await this.saveStorageState(accountId, state);
    const values = { state: "ACTIVE" as const, loggedInAt, lastOkAt: loggedInAt, failureCount: 0 };
    await this.db
      .insert(portalSessions)
      .values({ portalAccountId: accountId, ...values })
      .onConflictDoUpdate({ target: portalSessions.portalAccountId, set: { ...values, updatedAt: sql`now()` } });
  }

  /** The portal answered as logged in. */
  async markOk(accountId: string, at: Date): Promise<void> {
    await this.db
      .update(portalSessions)
      .set({ state: "ACTIVE", lastOkAt: at, failureCount: 0, updatedAt: at })
      .where(eq(portalSessions.portalAccountId, accountId));
  }

  /** The portal didn't answer, or answered with something unreadable. Says nothing about the session. */
  async markCheckFailed(accountId: string, at: Date): Promise<void> {
    await this.db
      .update(portalSessions)
      .set({ failureCount: sql`${portalSessions.failureCount} + 1`, updatedAt: at })
      .where(eq(portalSessions.portalAccountId, accountId));
  }

  /**
   * The portal answered as logged out, so only a new login can help. Records the
   * lifetime. Ignored if a new login was stored since `version` was read.
   */
  async markEnded(accountId: string, version: number, at: Date, reason: string): Promise<boolean> {
    return this.db.transaction(async (tx) => {
      const [blob] = await tx
        .select({ version: secretBlobs.version })
        .from(secretBlobs)
        .where(and(eq(secretBlobs.portalAccountId, accountId), eq(secretBlobs.kind, "storage_state")))
        .for("update");
      if (blob?.version !== version) return false;
      const [session] = await tx.select().from(portalSessions).where(eq(portalSessions.portalAccountId, accountId));
      if (session?.state === "NEEDS_USER") return false;
      await tx.insert(sessionEnds).values({
        portalAccountId: accountId,
        loggedInAt: session?.loggedInAt ?? null,
        lastOkAt: session?.lastOkAt ?? null,
        endedAt: at,
        reason,
      });
      await tx
        .insert(portalSessions)
        .values({ portalAccountId: accountId, state: "NEEDS_USER" })
        .onConflictDoUpdate({ target: portalSessions.portalAccountId, set: { state: "NEEDS_USER", updatedAt: at } });
      return true;
    });
  }

  async sessionStatus(accountId: string): Promise<SessionStatus | null> {
    const [row] = await this.db
      .select({
        state: portalSessions.state,
        loggedInAt: portalSessions.loggedInAt,
        lastOkAt: portalSessions.lastOkAt,
        failureCount: portalSessions.failureCount,
      })
      .from(portalSessions)
      .where(eq(portalSessions.portalAccountId, accountId));
    return row ?? null;
  }
}
