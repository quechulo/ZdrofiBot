import * as cheerio from "cheerio";

export type SessionState = "authenticated" | "logged-out" | "unknown";
export type RegistrationWindow = "not-open" | "open" | "closed";

export interface ScheduleItem {
  id: number;
  clubSlug: string;
  /** Portal local time, "YYYY-MM-DD HH:mm". */
  startsAtLocal: string;
  name: string;
  window: RegistrationWindow;
  full: boolean;
  seatsTaken: number | null;
  seatsTotal: number | null;
}

export interface ClassPage {
  id: number;
  /** A logged-out page still has a register token, so check this before using it. */
  session: SessionState;
  window: RegistrationWindow;
  memberRegistered: boolean;
  seatsTaken: number | null;
  seatsTotal: number | null;
  /** Only present once registration is open and the member isn't registered. */
  registerToken: string | null;
  /** Only present on the unregister page of a registered class. */
  unregisterToken: string | null;
}

interface PageLike {
  status: number;
  url: string;
  html: string;
}

const LOGOUT_LINK = 'a[href*="logout"]';
const LOGIN_FORM = 'form[name="member_login_form"]';

export function classifySession({ status, url, html }: PageLike): SessionState {
  const $ = cheerio.load(html);
  if ($(LOGOUT_LINK).length > 0 || html.includes("Wyloguj się")) return "authenticated";
  if (status === 401 || status === 403 || url.includes("/login") || $(LOGIN_FORM).length > 0) {
    return "logged-out";
  }
  return "unknown";
}

function windowFrom(classes: string): RegistrationWindow {
  if (classes.includes("item-registration-early")) return "not-open";
  if (classes.includes("item-registration-late")) return "closed";
  return "open";
}

function seats(text: string): { seatsTaken: number | null; seatsTotal: number | null } {
  const match = text.match(/(\d+)\s*\/\s*(\d+)/);
  return { seatsTaken: match ? Number(match[1]) : null, seatsTotal: match ? Number(match[2]) : null };
}

export function parseSchedule(html: string): ScheduleItem[] {
  const $ = cheerio.load(html);
  return $("li.club-schedule-item[data-id]")
    .toArray()
    .map((element) => {
      const item = $(element);
      return {
        id: Number(item.attr("data-id")),
        clubSlug: item.attr("data-club") ?? "",
        startsAtLocal: item.find("time[datetime]").attr("datetime")?.trim() ?? "",
        name: item.find("a.activity").text().replace(/\s+/g, " ").trim(),
        window: windowFrom(item.attr("class") ?? ""),
        full: item.attr("data-full") === "true",
        ...seats(item.find(".users").text()),
      };
    });
}

export function parseClassPage(page: PageLike, id: number): ClassPage {
  const $ = cheerio.load(page.html);
  const item = $(`#schedule-item-${id}`);
  const classes = item.attr("class") ?? "";
  const token = (form: string) => $(`input[name="${form}[_token]"]`).attr("value") ?? null;
  return {
    id,
    session: classifySession(page),
    window: windowFrom(classes),
    memberRegistered: classes.includes("item-member-registered"),
    ...seats(item.find(".users").text()),
    registerToken: token("schedule_register_form"),
    unregisterToken: token("schedule_unregister_form"),
  };
}

export type RegistrationOutcome = "booked" | "session-lost" | "unknown";

/**
 * Strict on purpose: the MVP accepted "Zapisano" anywhere on the page. "booked"
 * also covers "already booked", because the portal returns the same page for
 * both. Anything else stays "unknown", and the caller must verify it.
 */
export function classifyRegistration(page: PageLike, id: number): RegistrationOutcome {
  const $ = cheerio.load(page.html);
  const item = $(`#schedule-item-${id}`);
  const confirmed = $(`#a${id}`).text().includes("Zapisano");
  if (item.hasClass("item-member-registered") && confirmed) return "booked";
  return classifySession(page) === "logged-out" ? "session-lost" : "unknown";
}

export function classifyUnregistration(page: PageLike, id: number): "cancelled" | "session-lost" | "unknown" {
  const $ = cheerio.load(page.html);
  const item = $(`#schedule-item-${id}`);
  if (item.length > 0 && !item.hasClass("item-member-registered")) return "cancelled";
  return classifySession(page) === "logged-out" ? "session-lost" : "unknown";
}
