import { LocalKeyWrapper, SecretBox } from "@zdrofibot/crypto";
import { portalAccounts, portalActivities, registrationJobs, users, type AnyDatabase } from "@zdrofibot/db";
import { createTestDb } from "@zdrofibot/db/testing";
import { MockPortal, type MockClass } from "@zdrofibot/mock-portal";
import type { StoredState } from "@zdrofibot/portal";
import { SessionVault } from "@zdrofibot/sessions";
import type { Log } from "../src/log.js";

export const CLUB = "warszawa-zoliborz-szamocka";
export const MINUTE = 60_000;
export const DAY = 24 * 60 * MINUTE;

export class MemoryLog implements Log {
  lines: string[] = [];
  log(message: string) {
    this.lines.push(message);
  }
  warn(message: string) {
    this.lines.push(message);
  }
  error(message: string) {
    this.lines.push(message);
  }
}

export interface TestWorld {
  db: AnyDatabase;
  vault: SessionVault;
  portal: MockPortal;
  log: MemoryLog;
  portalOptions: { portalOrigin: string; userAgent: string };
}

export async function createWorld(classes: MockClass[] = []): Promise<TestWorld> {
  const db = await createTestDb();
  const portal = new MockPortal({ classes });
  await portal.start();
  return {
    db,
    vault: new SessionVault(db, new SecretBox(new LocalKeyWrapper(LocalKeyWrapper.generateKey()))),
    portal,
    log: new MemoryLog(),
    portalOptions: { portalOrigin: portal.url, userAgent: "test-agent" },
  };
}

export function stateFor(world: TestWorld, cookie: string): StoredState {
  const host = new URL(world.portal.url).hostname;
  return {
    cookies: [{ name: "SULUSESSID", value: cookie, domain: host, path: "/", expires: -1, httpOnly: true, secure: false, sameSite: "Lax" }],
    origins: [],
  };
}

/** A user with a portal account and, if a cookie is given, a stored session the portal knows. */
export async function addUser(world: TestWorld, cookie: string | null, loggedInAt = new Date()) {
  const [user] = await world.db.insert(users).values({ displayName: "Test" }).returning();
  const [account] = await world.db
    .insert(portalAccounts)
    .values({ userId: user!.id, login: "x", homeClubSlug: CLUB })
    .returning();
  if (cookie) {
    await world.vault.storeLogin(account!.id, stateFor(world, cookie), loggedInAt);
    world.portal.addSession(cookie);
  }
  return { userId: user!.id, accountId: account!.id };
}

export async function addActivity(world: TestWorld, id: number, opensAt: Date, name = "Joga") {
  await world.db.insert(portalActivities).values({
    id,
    clubSlug: CLUB,
    name,
    window: "not-open",
    opensAt,
    startsAt: new Date(opensAt.getTime() + 2 * DAY),
  });
}

export async function addJob(world: TestWorld, userId: string, activityId: number, opensAt: Date, state: "SCHEDULED" | "ARMED" = "SCHEDULED") {
  const [job] = await world.db
    .insert(registrationJobs)
    .values({ userId, portalActivityId: activityId, opensAt, state })
    .returning();
  return job!.id;
}

export const mockClass = (id: number, opensAtMs: number, startsAtLocal: string): MockClass => ({
  id,
  opensAtMs,
  startsAtLocal,
  seatsTaken: 3,
  seatsTotal: 17,
  name: "Joga",
});
