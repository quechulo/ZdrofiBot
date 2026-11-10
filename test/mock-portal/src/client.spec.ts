import { PortalClient, PortalCookieJar, tokenCore } from "@zdrofibot/portal";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MockPortal, type MockClass } from "./index.js";

const CLUB = "warszawa-zoliborz-szamocka";
const SESSION = "session-one";
const START = 1_800_000_000_000;
const HOUR = 3_600_000;

let now: number;
let portal: MockPortal;
let classes: Record<"open" | "open2" | "notOpen" | "full", MockClass>;

const makeClass = (id: number, opensAtMs: number, seatsTaken = 3, seatsTotal = 17): MockClass => ({
  id, opensAtMs, seatsTaken, seatsTotal, startsAtLocal: "2027-01-15 18:00", name: "Joga",
});

function client(sessionCookie: string | null = SESSION) {
  const host = new URL(portal.url).hostname;
  const cookies = sessionCookie
    ? [{ name: "SULUSESSID", value: sessionCookie, domain: host, path: "/", expires: -1, httpOnly: true, secure: false, sameSite: "Lax" as const }]
    : [];
  return new PortalClient({
    origin: portal.url,
    userAgent: "test-agent",
    jar: new PortalCookieJar(host, { cookies, origins: [] }),
  });
}

async function registerToken(id: number): Promise<string> {
  const token = (await client().fetchClassPage(CLUB, id)).registerToken;
  if (!token) throw new Error(`No token on class ${id}`);
  return token;
}

beforeEach(async () => {
  now = START;
  classes = {
    open: makeClass(101, START - HOUR),
    open2: makeClass(102, START - HOUR),
    notOpen: makeClass(103, START + HOUR),
    full: makeClass(104, START - HOUR, 17, 17),
  };
  portal = new MockPortal({ classes: Object.values(classes), now: () => now });
  await portal.start();
  portal.addSession(SESSION);
});

afterEach(() => portal.stop());

describe("reading", () => {
  it("reads the public schedule with no session", async () => {
    const items = await client(null).fetchSchedule(CLUB);
    expect(items.map((item) => [item.id, item.window, item.full])).toEqual([
      [101, "open", false],
      [102, "open", false],
      [103, "not-open", false],
      [104, "open", true],
    ]);
  });

  it("reports whether the session is alive", async () => {
    expect(await client().checkSession()).toBe("authenticated");
    portal.endSession(SESSION);
    expect(await client().checkSession()).toBe("logged-out");
  });
});

describe("the token flow the fire engine depends on", () => {
  it("re-masks the token per render, over one stable value", async () => {
    const [first, second] = [await registerToken(101), await registerToken(102)];
    expect(first).not.toBe(second);
    expect(tokenCore(first)).toBe(tokenCore(second));
  });

  it("books a class at opening with a token taken before it opened", async () => {
    const page = await client().fetchClassPage(CLUB, classes.notOpen.id);
    expect(page.registerToken).toBeNull();
    const token = await registerToken(classes.open.id);

    now = classes.notOpen.opensAtMs;
    const result = await client().register(CLUB, classes.notOpen.id, token);

    expect(result.outcome).toBe("booked");
    expect(portal.isBooked(SESSION, classes.notOpen.id)).toBe(true);
    expect(portal.posts()).toHaveLength(1);
  });
});

describe("register", () => {
  it("sends a clean Origin and Referer, unlike the MVP", async () => {
    await client().register(CLUB, 101, await registerToken(101));
    const [post] = portal.posts();
    expect(post?.origin).toBe(portal.url);
    expect(post?.referer).toBe(`${portal.url}/kluby-fitness/${CLUB}/grafik-zajec/101`);
  });

  it("treats a repeat POST as booked, and takes only one seat", async () => {
    const token = await registerToken(101);
    await client().register(CLUB, 101, token);
    expect((await client().register(CLUB, 101, token)).outcome).toBe("booked");
    expect(classes.open.seatsTaken).toBe(4);
  });

  it("doesn't claim success for a class that isn't open", async () => {
    const result = await client().register(CLUB, 103, await registerToken(101));
    expect(result.outcome).toBe("unknown");
    expect(portal.isBooked(SESSION, 103)).toBe(false);
  });

  it("doesn't claim success for a full class", async () => {
    expect((await client().register(CLUB, 104, await registerToken(101))).outcome).toBe("unknown");
  });

  it("flags a token from a dead session, and the portal rejects it", async () => {
    portal.endSession(SESSION);
    const page = await client().fetchClassPage(CLUB, 101);
    expect(page.registerToken).not.toBeNull();
    expect(page.session).toBe("logged-out");
    expect((await client().register(CLUB, 101, page.registerToken ?? "")).outcome).toBe("session-lost");
    expect(classes.open.seatsTaken).toBe(3);
  });

  it("reports a dead session instead of a failed booking", async () => {
    const token = await registerToken(101);
    portal.endSession(SESSION);
    expect((await client().register(CLUB, 101, token)).outcome).toBe("session-lost");
  });

  it("returns no-response without retrying when the reply is lost", async () => {
    portal.lostResponses.add(101);
    const result = await client().register(CLUB, 101, await registerToken(101), 200);

    expect(result.outcome).toBe("no-response");
    expect(portal.posts()).toHaveLength(1);
    // The Oct 26 trap: no reply, yet the portal may have booked it.
    expect(portal.isBooked(SESSION, 101)).toBe(true);
  });
});

describe("unregister", () => {
  it("cancels with its own token, and the class can be booked again", async () => {
    await client().register(CLUB, 101, await registerToken(101));

    const page = await client().fetchUnregisterPage(CLUB, 101);
    const result = await client().unregister(CLUB, 101, page.unregisterToken ?? "");

    expect(result.outcome).toBe("cancelled");
    expect(classes.open.seatsTaken).toBe(3);
    expect((await client().fetchClassPage(CLUB, 101)).registerToken).not.toBeNull();
  });

  it("rejects the register token, because tokens are per form", async () => {
    const token = await registerToken(101);
    await client().register(CLUB, 101, token);
    expect((await client().unregister(CLUB, 101, token)).outcome).toBe("unknown");
    expect(portal.isBooked(SESSION, 101)).toBe(true);
  });
});
