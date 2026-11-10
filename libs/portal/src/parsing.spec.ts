import fs from "node:fs";
import { describe, expect, it } from "vitest";
import { PortalCookieJar } from "./cookies.js";
import {
  classifyRegistration,
  classifySession,
  classifyUnregistration,
  parseClassPage,
  parseSchedule,
} from "./parsing.js";
import { clubSlugFromLink, portalPaths } from "./paths.js";
import { tokenCore } from "./token.js";

const fixture = (name: string) =>
  fs.readFileSync(new URL(`../../../test/mock-portal/fixtures/${name}`, import.meta.url), "utf8");
const page = (html: string, status = 200, url = "https://zdrofit.pl/zajecia") => ({ status, url, html });

const FIXTURE_CORE = "fixture-token-core-not-a-real-csrf-token-000";
const BOOKED_ID = 2544368;

describe("parseSchedule on the real markup", () => {
  const items = parseSchedule(fixture("schedule.html"));

  it("reads every class with its fields", () => {
    expect(items).toHaveLength(8);
    for (const item of items) {
      expect(item.id).toBeGreaterThan(0);
      expect(item.clubSlug).toBe("warszawa-zoliborz-szamocka");
      expect(item.startsAtLocal).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/);
      expect(item.name.length).toBeGreaterThan(0);
      expect(item.seatsTotal).toBeGreaterThan(0);
    }
  });

  it("tells not-open, open and closed classes apart", () => {
    const count = (window: string) => items.filter((item) => item.window === window).length;
    expect([count("closed"), count("not-open"), count("open")]).toEqual([2, 2, 4]);
  });

  it("treats a full class as open, because it keeps its Zapisz się button", () => {
    const full = items.filter((item) => item.full);
    expect(full).toHaveLength(2);
    expect(full.every((item) => item.window === "open" && item.seatsTaken === item.seatsTotal)).toBe(true);
  });
});

describe("classifySession", () => {
  it("recognises logged-in and logged-out pages", () => {
    expect(classifySession(page(fixture("class-open.html")))).toBe("authenticated");
    expect(classifySession(page(fixture("schedule.html")))).toBe("logged-out");
  });

  it("isn't fooled by /logout inside a script on a logged-out page", () => {
    const html = `<form name="member_login_form"></form><script>location.href="/logout"</script>`;
    expect(classifySession(page(html))).toBe("logged-out");
  });

  it("treats 401, 403 and login redirects as logged out", () => {
    expect(classifySession(page("", 401))).toBe("logged-out");
    expect(classifySession(page("", 403))).toBe("logged-out");
    expect(classifySession(page("", 200, "https://zdrofit.pl/login"))).toBe("logged-out");
  });

  it("doesn't call an unrecognised page a live session", () => {
    expect(classifySession(page("<html>Service unavailable</html>", 503))).toBe("unknown");
  });
});

describe("parseClassPage", () => {
  it("finds the register token on an open class", () => {
    const parsed = parseClassPage(page(fixture("class-open.html")), 2546335);
    expect(parsed.session).toBe("authenticated");
    expect(parsed.window).toBe("open");
    expect(parsed.memberRegistered).toBe(false);
    expect(tokenCore(parsed.registerToken ?? "")).toBe(FIXTURE_CORE);
    expect(parsed.seatsTotal).toBe(36);
  });

  it("reports a logged-out page even when it has a token, as the real portal does", () => {
    const loginForm = fixture("schedule.html").match(/<form\b[^>]*name="member_login_form"[\s\S]*?<\/form>/)?.[0] ?? "";
    const anonymous = fixture("class-open.html").replace(/<header>[\s\S]*?<\/header>/, loginForm);
    const parsed = parseClassPage(page(anonymous), 2546335);
    expect(parsed.registerToken).not.toBeNull();
    expect(parsed.session).toBe("logged-out");
  });

  it("finds no token before opening", () => {
    const parsed = parseClassPage(page(fixture("class-not-open.html")), 2558765);
    expect(parsed.window).toBe("not-open");
    expect(parsed.registerToken).toBeNull();
    expect(parsed.unregisterToken).toBeNull();
  });

  it("finds a booking and the separate unregister token", () => {
    expect(parseClassPage(page(fixture("class-booked.html")), BOOKED_ID).memberRegistered).toBe(true);
    const unregister = parseClassPage(page(fixture("class-unregister.html")), BOOKED_ID);
    expect(unregister.unregisterToken).not.toBeNull();
    expect(unregister.registerToken).toBeNull();
  });
});

describe("classifyRegistration", () => {
  it("accepts the real confirmation page", () => {
    expect(classifyRegistration(page(fixture("class-booked.html")), BOOKED_ID)).toBe("booked");
  });

  it("doesn't accept a booking of a different class", () => {
    expect(classifyRegistration(page(fixture("class-booked.html")), 1)).toBe("unknown");
  });

  it("isn't fooled by Zapisano elsewhere on the page, as the MVP was", () => {
    const html = fixture("class-open.html").replace("</main>", "<p>Zapisano</p></main>");
    expect(classifyRegistration(page(html), 2546335)).toBe("unknown");
  });

  it("recognises the real refusal for a class that isn't open yet", () => {
    expect(classifyRegistration(page(fixture("post-not-open.html")), 2558759)).toBe("not-open");
  });

  it("reports a lost session separately", () => {
    expect(classifyRegistration(page(fixture("schedule.html")), BOOKED_ID)).toBe("session-lost");
  });
});

describe("classifyUnregistration", () => {
  it("needs the class to be shown as not registered", () => {
    expect(classifyUnregistration(page(fixture("class-open.html")), 2546335)).toBe("cancelled");
    expect(classifyUnregistration(page(fixture("class-booked.html")), BOOKED_ID)).toBe("unknown");
  });
});

describe("tokenCore", () => {
  it("rejects anything that isn't in the masked format", () => {
    expect(tokenCore("plain-token")).toBeNull();
    expect(tokenCore("a..b")).toBeNull();
  });
});

describe("PortalCookieJar", () => {
  const session = {
    name: "SULUSESSID", value: "one", domain: "zdrofit.pl", path: "/",
    expires: -1, httpOnly: true, secure: true, sameSite: "Lax" as const,
  };
  const foreign = { ...session, name: "tracker", value: "x", domain: ".doubleclick.net" };
  const jar = () => new PortalCookieJar("zdrofit.pl", { cookies: [session, foreign], origins: [] });

  it("sends only the portal's cookies", () => {
    expect(jar().header()).toBe("SULUSESSID=one");
  });

  it("tracks rotation, and keeps cookies it doesn't send", () => {
    const cookies = jar();
    expect(cookies.apply("SULUSESSID=two; path=/; HttpOnly")).toEqual({ name: "SULUSESSID", change: "rotated" });
    expect(cookies.apply("SULUSESSID=two; path=/")).toEqual({ name: "SULUSESSID", change: "unchanged" });
    expect(cookies.toState().cookies.map((cookie) => cookie.name)).toContain("tracker");
  });

  it("removes a cookie by Max-Age or a past Expires", () => {
    const byAge = jar();
    expect(byAge.apply("SULUSESSID=x; Max-Age=0").change).toBe("deleted");
    expect(byAge.hasSession()).toBe(false);
    expect(jar().apply("SULUSESSID=x; Expires=Thu, 01 Jan 2015 00:00:00 GMT").change).toBe("deleted");
  });
});

describe("portal paths", () => {
  it("refuses a club slug that could change the path", () => {
    expect(() => portalPaths.schedule("../logout")).toThrow("Invalid club slug");
  });

  it("reads the club from a schedule link", () => {
    expect(clubSlugFromLink("https://zdrofit.pl/kluby-fitness/warszawa-zoliborz-szamocka/grafik-zajec")).toBe(
      "warszawa-zoliborz-szamocka",
    );
  });
});
