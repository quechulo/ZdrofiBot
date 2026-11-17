import { LocalKeyWrapper, SecretBox } from "@zdrofibot/crypto";
import { portalAccounts, portalActivities, registrationJobs, users, type AnyDatabase } from "@zdrofibot/db";
import { createTestDb } from "@zdrofibot/db/testing";
import { MockPortal, type MockClass } from "@zdrofibot/mock-portal";
import { PortalClient, PortalCookieJar, type StoredState } from "@zdrofibot/portal";
import { SessionVault } from "@zdrofibot/sessions";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { FireTimings } from "./config.js";
import { FireEngine } from "./fire-engine.js";
import type { Log } from "./fire-runner.js";
import { JobStore } from "./job-store.js";

const CLUB = "warszawa-zoliborz-szamocka";
const SOURCE = 900;
const TARGET = 901;
const DAY = 24 * 60 * 60_000;

/** The production timeline, compressed to about a second. */
const FAST: FireTimings = {
  armLeadMs: 60_000,
  armIntervalMs: 60_000,
  leaseMs: 5_000,
  renewIntervalMs: 60_000,
  prepareLeadMs: 500,
  prepareRetryMs: 100,
  lastReloadLeadMs: 150,
  warmLeadMs: 250,
  warmTimeoutMs: 200,
  firingLeadMs: 100,
  firingLeaseMs: 3_000,
  quietBeforeMs: 150,
  quietAfterMs: 50,
  fireOffsetMs: 0,
  connectTimeoutMs: 500,
  postTimeoutMs: 600,
  maxPosts: 3,
  retryWindowMs: 1_500,
  minRetryGapMs: 50,
  verifyAttempts: 3,
  verifyGapMs: 50,
  repostWindowMs: 3_000,
  lateLimitMs: 2_000,
  drainKeepMs: 2_000,
};

const quietLog: Log & { lines: string[] } = {
  lines: [],
  log(message) { this.lines.push(message); },
  warn(message) { this.lines.push(message); },
  error(message) { this.lines.push(message); },
};

let db: AnyDatabase;
let vault: SessionVault;
let portal: MockPortal;
let engines: FireEngine[];

const host = () => new URL(portal.url).hostname;
const stateFor = (cookie: string): StoredState => ({
  cookies: [{ name: "SULUSESSID", value: cookie, domain: host(), path: "/", expires: -1, httpOnly: true, secure: false, sameSite: "Lax" }],
  origins: [],
});

const mockClass = (id: number, opensAtMs: number, seatsTaken = 3, seatsTotal = 17): MockClass => ({
  id, opensAtMs, seatsTaken, seatsTotal, name: "Joga", startsAtLocal: "2027-01-15 18:00",
});

async function startPortal(...classes: MockClass[]) {
  portal = new MockPortal({ classes });
  await portal.start();
}

async function addUser(cookie: string | null, knownToPortal = true) {
  const [user] = await db.insert(users).values({ displayName: "Test" }).returning();
  const [account] = await db.insert(portalAccounts).values({ userId: user!.id, login: "x", homeClubSlug: CLUB }).returning();
  if (cookie) {
    await vault.saveStorageState(account!.id, stateFor(cookie));
    if (knownToPortal) portal.addSession(cookie);
  }
  return { userId: user!.id, accountId: account!.id };
}

async function addActivity(id: number, opensAt: number, window: "open" | "not-open") {
  await db.insert(portalActivities).values({
    id, clubSlug: CLUB, name: "Joga", window, opensAt: new Date(opensAt), startsAt: new Date(opensAt + 2 * DAY),
  });
}

async function addJob(userId: string, opensAt: number, extra: Partial<typeof registrationJobs.$inferInsert> = {}) {
  const [job] = await db
    .insert(registrationJobs)
    .values({ userId, portalActivityId: TARGET, opensAt: new Date(opensAt), ...extra })
    .returning();
  return job!.id;
}

const jobRow = async (id: string) => (await db.select().from(registrationJobs).where(eq(registrationJobs.id, id)))[0]!;

function engine(workerId = "worker-1", timings: FireTimings = FAST) {
  const created = new FireEngine({
    store: new JobStore(db, workerId, timings.leaseMs),
    vault,
    timings,
    portalOrigin: portal.url,
    userAgent: "test-agent",
    log: quietLog,
  });
  engines.push(created);
  return created;
}

/** One claim, then wait for every job it armed to finish. */
async function runOnce(fireEngine = engine()) {
  await fireEngine.tick();
  await Promise.all([...fireEngine.active.values()].map((runner) => runner.done));
  return fireEngine;
}

/** The usual case: an open class to take a token from, and a target opening at T. */
async function standardSetup(T: number, target: Partial<MockClass> = {}) {
  await startPortal(mockClass(SOURCE, Date.now() - DAY), { ...mockClass(TARGET, T), ...target });
  await addActivity(SOURCE, Date.now() - DAY, "open");
  await addActivity(TARGET, T, "not-open");
}

beforeEach(async () => {
  db = await createTestDb();
  vault = new SessionVault(db, new SecretBox(new LocalKeyWrapper(LocalKeyWrapper.generateKey())));
  engines = [];
  quietLog.lines = [];
});

afterEach(async () => {
  for (const fireEngine of engines) await fireEngine.stop();
  await portal?.stop();
});

describe("firing at T", () => {
  it("books with a token taken from another class before opening, in a single POST", async () => {
    const T = Date.now() + 700;
    await standardSetup(T);
    const { userId } = await addUser("s1");
    const id = await addJob(userId, T);
    let stateWhenPostArrived: string | undefined;
    portal.onPost = async () => {
      stateWhenPostArrived = (await jobRow(id)).state;
    };

    await runOnce();

    const job = await jobRow(id);
    expect(job.state).toBe("BOOKED");
    expect(job.postsSent).toBe(1);
    expect(job.sendLatencyMs).toBeGreaterThanOrEqual(0);
    expect(job.sendLatencyMs).toBeLessThan(100);
    expect(job.confirmedAt!.getTime()).toBeGreaterThanOrEqual(job.sentAt!.getTime());
    expect(stateWhenPostArrived).toBe("FIRING");
    expect(portal.isBooked("s1", TARGET)).toBe(true);

    const [post] = portal.posts();
    expect(portal.posts()).toHaveLength(1);
    expect(post!.at).toBeGreaterThanOrEqual(T);
    expect(post!.origin).toBe(portal.url);
    const tokenRead = portal.requests.find((request) => request.path.endsWith(`/${SOURCE}`));
    expect(tokenRead!.at).toBeLessThan(T);
  });

  it("reads the target's own page at T when no open class is known", async () => {
    const T = Date.now() + 700;
    await startPortal(mockClass(TARGET, T));
    await addActivity(TARGET, T, "not-open");
    const { userId } = await addUser("s1");
    const id = await addJob(userId, T);

    await runOnce();

    expect((await jobRow(id)).state).toBe("BOOKED");
    const targetRead = portal.requests.find((request) => request.method === "GET" && request.path.endsWith(`/${TARGET}`));
    expect(targetRead!.at).toBeGreaterThanOrEqual(T);
    expect(portal.posts()).toHaveLength(1);
  });

  it("retries a slightly late opening", async () => {
    const T = Date.now() + 700;
    await standardSetup(T, { opensAtMs: T + 150 });
    portal.postDelayMs = 100;
    const { userId } = await addUser("s1");
    const id = await addJob(userId, T);

    await runOnce();

    const job = await jobRow(id);
    expect(job.state).toBe("BOOKED");
    expect(job.postsSent).toBe(2);
  });

  it("stops retrying 'not open yet' at the POST limit", async () => {
    const T = Date.now() + 700;
    await standardSetup(T, { opensAtMs: T + 60_000 });
    const { userId } = await addUser("s1");
    const id = await addJob(userId, T);

    await runOnce();

    const job = await jobRow(id);
    expect([job.state, job.errorCode, job.postsSent]).toEqual(["FAILED", "not-open", FAST.maxPosts]);
    expect(portal.posts()).toHaveLength(FAST.maxPosts);
  });

  it("reports a full class as FULL", async () => {
    const T = Date.now() + 700;
    await standardSetup(T, { seatsTaken: 17, seatsTotal: 17 });
    const { userId } = await addUser("s1");
    const id = await addJob(userId, T);

    await runOnce();

    const job = await jobRow(id);
    expect([job.state, job.postsSent]).toEqual(["FULL", 1]);
  });

  it("fires both users at T when two want the same class", async () => {
    const T = Date.now() + 700;
    await standardSetup(T);
    const first = await addUser("s1");
    const second = await addUser("s2");
    await addJob(first.userId, T);
    const secondJob = await addJob(second.userId, T);

    await runOnce();

    expect(portal.isBooked("s1", TARGET) && portal.isBooked("s2", TARGET)).toBe(true);
    const sends = portal.posts().map((post) => post.at - T);
    expect(sends).toHaveLength(2);
    for (const offset of sends) expect(offset).toBeLessThan(50);
    expect((await jobRow(secondJob)).state).toBe("BOOKED");
  });
});

describe("unclear outcomes", () => {
  it("checks the class page after a lost response, and doesn't resend when it worked", async () => {
    const T = Date.now() + 700;
    await standardSetup(T);
    portal.lostResponses.add(TARGET);
    const { userId } = await addUser("s1");
    const id = await addJob(userId, T);

    await runOnce();

    const job = await jobRow(id);
    expect([job.state, job.postsSent]).toEqual(["BOOKED", 1]);
    expect(portal.posts()).toHaveLength(1);
  });

  it("sends once more after checking, and the portal still books only one seat", async () => {
    const T = Date.now() + 700;
    await standardSetup(T);
    // The first POST times out client-side and books only after the check has run.
    portal.postDelayMs = 900;
    const { userId } = await addUser("s1");
    const id = await addJob(userId, T);

    await runOnce();

    const job = await jobRow(id);
    expect([job.state, job.postsSent]).toEqual(["BOOKED", 2]);
    expect(portal.posts()).toHaveLength(2);
    const page = await sessionClient("s1").fetchClassPage(CLUB, TARGET);
    expect(page.seatsTaken).toBe(4);
  });
});

function sessionClient(cookie: string) {
  return new PortalClient({ origin: portal.url, userAgent: "test-agent", jar: new PortalCookieJar(host(), stateFor(cookie)) });
}

describe("sessions", () => {
  it("sends nothing when the session is dead", async () => {
    const T = Date.now() + 700;
    await standardSetup(T);
    const { userId } = await addUser("dead", false);
    const id = await addJob(userId, T);

    await runOnce();

    const job = await jobRow(id);
    expect([job.state, job.errorCode, job.postsSent]).toEqual(["FAILED", "session-lost", 0]);
    expect(portal.posts()).toHaveLength(0);
  });

  it("picks up a reconnect made shortly before T", async () => {
    const T = Date.now() + 700;
    await standardSetup(T);
    const { userId, accountId } = await addUser("dead", false);
    const id = await addJob(userId, T);
    setTimeout(() => {
      portal.addSession("fresh");
      void vault.saveStorageState(accountId, stateFor("fresh"));
    }, T - 430 - Date.now());

    await runOnce();

    expect((await jobRow(id)).state).toBe("BOOKED");
    expect(portal.isBooked("fresh", TARGET)).toBe(true);
  });

  it("fails without a stored session", async () => {
    const T = Date.now() + 700;
    await standardSetup(T);
    const { userId } = await addUser(null);
    const id = await addJob(userId, T);

    await runOnce();

    expect((await jobRow(id)).errorCode).toBe("no-session");
  });
});

describe("timing edge cases", () => {
  it("fires at once when found shortly after T", async () => {
    const T = Date.now() - 1_000;
    await startPortal(mockClass(TARGET, T));
    await addActivity(TARGET, T, "open");
    const { userId } = await addUser("s1");
    const id = await addJob(userId, T);

    await runOnce();

    const job = await jobRow(id);
    expect([job.state, job.postsSent]).toEqual(["BOOKED", 1]);
    expect(job.sendLatencyMs).toBeGreaterThanOrEqual(1_000);
  });

  it("marks a job MISSED rather than firing it late", async () => {
    const T = Date.now() - 10_000;
    await startPortal(mockClass(TARGET, T));
    await addActivity(TARGET, T, "open");
    const { userId } = await addUser("s1");
    const id = await addJob(userId, T);

    await runOnce();

    expect((await jobRow(id)).state).toBe("MISSED");
    expect(portal.requests).toHaveLength(0);
  });

  it("sends nothing for a job cancelled while armed", async () => {
    const T = Date.now() + 700;
    await standardSetup(T);
    const { userId } = await addUser("s1");
    const id = await addJob(userId, T);

    const fireEngine = engine();
    await fireEngine.tick();
    await db.update(registrationJobs).set({ state: "CANCELLED" }).where(eq(registrationJobs.id, id));
    await Promise.all([...fireEngine.active.values()].map((runner) => runner.done));

    expect((await jobRow(id)).state).toBe("CANCELLED");
    expect(portal.posts()).toHaveLength(0);
  });
});

describe("crashes and shutdown", () => {
  it("checks a job interrupted mid-fire and finds the booking, without resending", async () => {
    const T = Date.now() - 500;
    await startPortal(mockClass(TARGET, T - DAY));
    await addActivity(TARGET, T, "open");
    const { userId } = await addUser("s1");
    const client = sessionClient("s1");
    await client.register(CLUB, TARGET, (await client.fetchClassPage(CLUB, TARGET)).registerToken!);
    const id = await addJob(userId, T, { state: "FIRING", workerId: "dead", leaseUntil: new Date(Date.now() - 1) });
    const postsBefore = portal.posts().length;

    await runOnce();

    expect((await jobRow(id)).state).toBe("BOOKED");
    expect(portal.posts()).toHaveLength(postsBefore);
  });

  it("never resends an interrupted job that didn't book", async () => {
    const T = Date.now() - 500;
    await startPortal(mockClass(TARGET, T - DAY));
    await addActivity(TARGET, T, "open");
    const { userId } = await addUser("s1");
    const id = await addJob(userId, T, { state: "FIRING", workerId: "dead", leaseUntil: new Date(Date.now() - 1) });

    await runOnce();

    const job = await jobRow(id);
    expect([job.state, job.errorCode]).toEqual(["FAILED", "interrupted"]);
    expect(portal.posts()).toHaveLength(0);
  });

  it("leaves a job alone while another worker's lease is live, and takes it once that lapses", async () => {
    await startPortal();
    const T = Date.now() + 30_000;
    await addActivity(TARGET, T, "not-open");
    const { userId } = await addUser("s1");
    await addJob(userId, T);
    const first = new JobStore(db, "worker-1", FAST.leaseMs);
    const second = new JobStore(db, "worker-2", FAST.leaseMs);
    const now = new Date();

    expect(await first.claimDue(now, FAST.armLeadMs, FAST.lateLimitMs, true)).toHaveLength(1);
    expect(await second.claimDue(now, FAST.armLeadMs, FAST.lateLimitMs, true)).toHaveLength(0);
    const later = new Date(now.getTime() + FAST.leaseMs + 1);
    expect(await second.claimDue(later, FAST.armLeadMs, FAST.lateLimitMs, false)).toHaveLength(1);
  });

  it("hands back distant jobs on shutdown", async () => {
    await startPortal();
    const T = Date.now() + 30_000;
    await addActivity(TARGET, T, "not-open");
    const { userId } = await addUser("s1");
    const id = await addJob(userId, T);

    const fireEngine = engine();
    await fireEngine.tick();
    expect((await jobRow(id)).state).toBe("ARMED");
    await fireEngine.stop();

    const job = await jobRow(id);
    expect([job.state, job.workerId]).toEqual(["SCHEDULED", null]);
  });

  it("restarted with the same id, retakes its own armed jobs at once", async () => {
    const T = Date.now() + 700;
    await standardSetup(T);
    const { userId } = await addUser("s1");
    const id = await addJob(userId, T, { state: "ARMED", workerId: "worker-1", leaseUntil: new Date(Date.now() + 60_000) });

    await runOnce(engine("worker-1"));

    expect((await jobRow(id)).state).toBe("BOOKED");
  });
});
