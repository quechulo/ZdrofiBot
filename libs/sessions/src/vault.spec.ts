import { LocalKeyWrapper, SecretBox } from "@zdrofibot/crypto";
import { portalAccounts, secretBlobs, sessionEnds, users, type AnyDatabase } from "@zdrofibot/db";
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

  it("returns null when there is no session yet", async () => {
    expect(await vault.loadSession(accountId)).toBeNull();
  });

  it("writes rotated cookies only over the version they were read from", async () => {
    await vault.saveStorageState(accountId, state("old"));
    const read = (await vault.loadSession(accountId))!;
    await vault.storeLogin(accountId, state("new-login"), new Date());

    expect(await vault.saveStorageState(accountId, state("rotated-old"), read.version)).toBe(false);
    expect((await vault.loadStorageState(accountId))!.cookies[0]!.value).toBe("new-login");

    const current = (await vault.loadSession(accountId))!;
    expect(await vault.saveStorageState(accountId, state("rotated-new"), current.version)).toBe(true);
    expect(await db.select().from(secretBlobs)).toHaveLength(1);
  });

  it("records a session's end with its lifetime, once", async () => {
    const loggedInAt = new Date("2026-11-18T08:00:00Z");
    await vault.storeLogin(accountId, state("s"), loggedInAt);
    const okAt = new Date("2026-11-18T20:00:00Z");
    await vault.markOk(accountId, okAt);
    const { version } = (await vault.loadSession(accountId))!;

    const endedAt = new Date("2026-11-18T20:30:00Z");
    expect(await vault.markEnded(accountId, version, endedAt, "keep-alive")).toBe(true);
    expect(await vault.markEnded(accountId, version, endedAt, "keep-alive")).toBe(false);

    expect((await vault.sessionStatus(accountId))!.state).toBe("NEEDS_USER");
    const [end] = await db.select().from(sessionEnds);
    expect([end!.loggedInAt, end!.lastOkAt, end!.endedAt]).toEqual([loggedInAt, okAt, endedAt]);
  });

  it("doesn't end a session that was replaced by a new login meanwhile", async () => {
    await vault.storeLogin(accountId, state("old"), new Date());
    const { version } = (await vault.loadSession(accountId))!;
    await vault.storeLogin(accountId, state("new"), new Date());

    expect(await vault.markEnded(accountId, version, new Date(), "keep-alive")).toBe(false);
    expect((await vault.sessionStatus(accountId))!.state).toBe("ACTIVE");
  });

  it("counts failed checks without changing the state", async () => {
    await vault.storeLogin(accountId, state("s"), new Date());
    await vault.markCheckFailed(accountId, new Date());
    await vault.markCheckFailed(accountId, new Date());
    expect(await vault.sessionStatus(accountId)).toMatchObject({ state: "ACTIVE", failureCount: 2 });
    await vault.markOk(accountId, new Date());
    expect((await vault.sessionStatus(accountId))!.failureCount).toBe(0);
  });
});
