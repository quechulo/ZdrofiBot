import { LocalKeyWrapper, SecretBox } from "@zdrofibot/crypto";
import { portalAccounts, secretBlobs, users, type AnyDatabase } from "@zdrofibot/db";
import { createTestDb } from "@zdrofibot/db/testing";
import type { StoredState } from "@zdrofibot/portal";
import { beforeEach, describe, expect, it } from "vitest";
import { SessionVault } from "./vault.js";

const state = (value: string): StoredState => ({
  cookies: [{ name: "SULUSESSID", value, domain: "zdrofit.pl", path: "/", expires: -1, httpOnly: true, secure: true, sameSite: "Lax" }],
  origins: [],
});

let db: AnyDatabase;
let vault: SessionVault;
let accountId: string;
let userId: string;

beforeEach(async () => {
  db = await createTestDb();
  vault = new SessionVault(db, new SecretBox(new LocalKeyWrapper(LocalKeyWrapper.generateKey())));
  const [user] = await db.insert(users).values({ displayName: "Test" }).returning();
  userId = user!.id;
  const [account] = await db.insert(portalAccounts).values({ userId, login: "a", homeClubSlug: "club" }).returning();
  accountId = account!.id;
});

describe("SessionVault", () => {
  it("finds the account for a user", async () => {
    expect(await vault.accountForUser(userId)).toEqual({ id: accountId, userId, homeClubSlug: "club" });
  });

  it("stores the session encrypted and reads it back", async () => {
    await vault.saveStorageState(accountId, state("secret-cookie"));
    const [row] = await db.select().from(secretBlobs);
    expect(row!.ciphertext.toString("latin1")).not.toContain("secret-cookie");
    expect(await vault.loadStorageState(accountId)).toEqual(state("secret-cookie"));
  });

  it("replaces the session when cookies rotate", async () => {
    await vault.saveStorageState(accountId, state("old"));
    await vault.saveStorageState(accountId, state("new"));
    expect(await db.select().from(secretBlobs)).toHaveLength(1);
    expect((await vault.loadStorageState(accountId))!.cookies[0]!.value).toBe("new");
  });

  it("returns null when there is no session yet", async () => {
    expect(await vault.loadStorageState(accountId)).toBeNull();
  });

  it("tracks the session state", async () => {
    expect(await vault.sessionState(accountId)).toBeNull();
    await vault.markActive(accountId, new Date());
    expect(await vault.sessionState(accountId)).toBe("ACTIVE");
    await vault.markNeedsUser(accountId);
    expect(await vault.sessionState(accountId)).toBe("NEEDS_USER");
  });
});
