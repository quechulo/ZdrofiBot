import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import * as schema from "./schema.js";
import { notifications, portalAccounts, portalActivities, registrationJobs, secretBlobs, users } from "./schema.js";

const migrationsFolder = fileURLToPath(new URL("../migrations", import.meta.url));
const OPENS = new Date("2027-01-13T17:00:00Z");

let db: ReturnType<typeof drizzle<typeof schema>>;
let userId: string;

async function addJob() {
  const [job] = await db
    .insert(registrationJobs)
    .values({ userId, portalActivityId: 1, opensAt: OPENS })
    .returning();
  return job!;
}

beforeEach(async () => {
  db = drizzle(new PGlite(), { schema });
  await migrate(db, { migrationsFolder });
  const [user] = await db.insert(users).values({ displayName: "Test" }).returning();
  userId = user!.id;
  await db.insert(portalActivities).values({
    id: 1, clubSlug: "club", name: "Joga", window: "not-open",
    startsAt: new Date("2027-01-15T17:00:00Z"), opensAt: OPENS,
  });
});

describe("registration jobs", () => {
  it("defaults a new job to SCHEDULED", async () => {
    expect((await addJob()).state).toBe("SCHEDULED");
  });

  it("refuses a second live job for the same class", async () => {
    await addJob();
    await expect(addJob()).rejects.toThrow();
  });

  it("allows booking again after a cancel, which the sketch's key blocked", async () => {
    const job = await addJob();
    await db.update(registrationJobs).set({ state: "CANCELLED" }).where(eq(registrationJobs.id, job.id));
    await expect(addJob()).resolves.toBeDefined();
  });
});

describe("notifications", () => {
  it("can't send the same rung twice", async () => {
    const job = await addJob();
    const [account] = await db
      .insert(portalAccounts)
      .values({ userId, login: "a", homeClubSlug: "club" })
      .returning();
    const rung = { portalAccountId: account!.id, jobId: job.id, rung: "T-60", channel: "telegram" };
    await db.insert(notifications).values(rung);
    await expect(db.insert(notifications).values(rung)).rejects.toThrow();
  });
});

describe("deleting a user", () => {
  it("removes their secrets with them", async () => {
    const [account] = await db
      .insert(portalAccounts)
      .values({ userId, login: "a", homeClubSlug: "club" })
      .returning();
    const blob = Buffer.from([1, 2, 3]);
    await db.insert(secretBlobs).values({
      portalAccountId: account!.id, kind: "password", ciphertext: blob, nonce: blob, wrappedDek: blob,
    });

    await db.delete(users).where(eq(users.id, userId));

    expect(await db.select().from(secretBlobs)).toHaveLength(0);
  });
});

describe("secret blobs", () => {
  it("keeps one row per secret kind", async () => {
    const [account] = await db
      .insert(portalAccounts)
      .values({ userId, login: "a", homeClubSlug: "club" })
      .returning();
    const blob = Buffer.from([1]);
    const row = { portalAccountId: account!.id, kind: "password" as const, ciphertext: blob, nonce: blob, wrappedDek: blob };
    await db.insert(secretBlobs).values(row);
    await expect(db.insert(secretBlobs).values(row)).rejects.toThrow();
  });
});
