import type { SecretBox } from "@zdrofibot/crypto";
import { portalAccounts, portalSessions, secretBlobs, type AnyDatabase } from "@zdrofibot/db";
import type { StoredState } from "@zdrofibot/portal";
import { and, eq, sql } from "drizzle-orm";

export interface PortalAccount {
  id: string;
  userId: string;
  homeClubSlug: string;
}

type SecretKind = (typeof secretBlobs.kind.enumValues)[number];

/** Ties a secret to its row, so ciphertext copied elsewhere won't decrypt. */
const context = (accountId: string, kind: SecretKind) => `${accountId}:${kind}`;

/**
 * Reads and writes a portal account's encrypted secrets and session state.
 * Only the workers use this. The API can't read `secret_blobs`.
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

  private async readSecret(accountId: string, kind: SecretKind): Promise<Buffer | null> {
    const [row] = await this.db
      .select()
      .from(secretBlobs)
      .where(and(eq(secretBlobs.portalAccountId, accountId), eq(secretBlobs.kind, kind)));
    return row ? this.box.open(row, context(accountId, kind)) : null;
  }

  private async writeSecret(accountId: string, kind: SecretKind, plaintext: Buffer): Promise<void> {
    const sealed = await this.box.seal(plaintext, context(accountId, kind));
    await this.db
      .insert(secretBlobs)
      .values({ portalAccountId: accountId, kind, ...sealed })
      .onConflictDoUpdate({
        target: [secretBlobs.portalAccountId, secretBlobs.kind],
        set: { ...sealed, updatedAt: sql`now()` },
      });
  }

  async loadStorageState(accountId: string): Promise<StoredState | null> {
    const plaintext = await this.readSecret(accountId, "storage_state");
    return plaintext ? (JSON.parse(plaintext.toString("utf8")) as StoredState) : null;
  }

  /** Also used for rotated cookies, so the next request doesn't send a dead session. */
  async saveStorageState(accountId: string, state: StoredState): Promise<void> {
    await this.writeSecret(accountId, "storage_state", Buffer.from(JSON.stringify(state)));
  }

  /** After a fresh login. */
  async markActive(accountId: string, loggedInAt: Date): Promise<void> {
    const values = { state: "ACTIVE" as const, loggedInAt, lastOkAt: loggedInAt, failureCount: 0 };
    await this.db
      .insert(portalSessions)
      .values({ portalAccountId: accountId, ...values })
      .onConflictDoUpdate({ target: portalSessions.portalAccountId, set: { ...values, updatedAt: sql`now()` } });
  }

  /** The portal answered as logged out, so only a new login can help. */
  async markNeedsUser(accountId: string): Promise<void> {
    await this.db
      .insert(portalSessions)
      .values({ portalAccountId: accountId, state: "NEEDS_USER" })
      .onConflictDoUpdate({
        target: portalSessions.portalAccountId,
        set: { state: "NEEDS_USER", updatedAt: sql`now()` },
      });
  }

  async sessionState(accountId: string) {
    const [row] = await this.db
      .select({ state: portalSessions.state })
      .from(portalSessions)
      .where(eq(portalSessions.portalAccountId, accountId));
    return row?.state ?? null;
  }
}
