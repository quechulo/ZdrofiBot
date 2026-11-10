import { describe, expect, it } from "vitest";
import { opensAt, parsePortalTime } from "./time.js";

describe("parsePortalTime", () => {
  it("reads Warsaw time in winter and summer", () => {
    expect(parsePortalTime("2026-11-06 19:00").toISOString()).toBe("2026-11-06T18:00:00.000Z");
    expect(parsePortalTime("2026-07-06 19:00").toISOString()).toBe("2026-07-06T17:00:00.000Z");
  });

  it("refuses anything else", () => {
    expect(() => parsePortalTime("06.11.2026 19:00")).toThrow("Invalid portal time");
    expect(() => parsePortalTime("")).toThrow("Invalid portal time");
  });
});

describe("opensAt", () => {
  const opening = (local: string) => opensAt(parsePortalTime(local)).toISOString();

  it("matches the real snapshot: a 19:00 class opens at 19:00 two days earlier", () => {
    expect(opening("2026-10-28 19:00")).toBe("2026-10-26T18:00:00.000Z");
  });

  it("uses elapsed hours across a DST change. Unverified against the portal", () => {
    // 12:00 summer time on 29 March is 11:00 winter time on 27 March.
    expect(opening("2027-03-29 12:00")).toBe("2027-03-27T10:00:00.000Z");
  });
});
