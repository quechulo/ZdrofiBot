import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { tokenCore } from "@zdrofibot/portal";

const fixture = (name: string) =>
  fs.readFileSync(new URL(`../fixtures/${name}`, import.meta.url), "utf8");

const FIXTURE = {
  schedule: fixture("schedule.html"),
  open: fixture("class-open.html"),
  notOpen: fixture("class-not-open.html"),
  postNotOpen: fixture("post-not-open.html"),
  booked: fixture("class-booked.html"),
  unregister: fixture("class-unregister.html"),
};
const FIXTURE_IDS = { open: 2546335, notOpen: 2558765, postNotOpen: 2558759, booked: 2544368, unregister: 2544368 };
const LOGIN_FORM = FIXTURE.schedule.match(/<form\b[^>]*name="member_login_form"[\s\S]*?<\/form>/)?.[0] ?? "";
const LOGGED_OUT_PAGE = `<!doctype html><html lang="pl"><body>${LOGIN_FORM}</body></html>`;
const CLUB = "warszawa-zoliborz-szamocka";

export interface MockClass {
  id: number;
  /** "YYYY-MM-DD HH:mm" */
  startsAtLocal: string;
  name: string;
  opensAtMs: number;
  closedAtMs?: number;
  seatsTaken: number;
  seatsTotal: number;
}

interface MockSession {
  registerCore: string;
  unregisterCore: string;
  booked: Set<number>;
}

export interface LoggedRequest {
  method: string;
  path: string;
  origin: string | undefined;
  referer: string | undefined;
  cookie: boolean;
  at: number;
}

export interface MockPortalOptions {
  classes?: MockClass[];
  now?: () => number;
}

/** Same "<noise>.<key>.<masked>" format the real portal renders. */
function mask(core: string): string {
  const key = crypto.randomBytes(32);
  const masked = Buffer.from(core).map((byte, index) => byte ^ (key[index % key.length] ?? 0));
  return `${crypto.randomBytes(3).toString("hex")}.${key.toString("base64url")}.${Buffer.from(masked).toString("base64url")}`;
}

const newCore = () => crypto.randomBytes(32).toString("base64url");
const withToken = (html: string, form: string, token: string) =>
  html.replace(new RegExp(`(name="${form}\\[_token\\]"\\s+value=")[^"]*`), `$1${token}`);

function personalise(html: string, fixtureId: number, cls: MockClass): string {
  const [day = "", time = ""] = cls.startsAtLocal.split(" ");
  return html
    .replaceAll(String(fixtureId), String(cls.id))
    .replace(/datetime="[^"]*"/, `datetime="${cls.startsAtLocal}"`)
    .replace(/data-day="[^"]*"/, `data-day="${day}"`)
    .replace(/(<time[^>]*>)[^<]*/, `$1${time}`)
    .replace(/(class="activity"[^>]*>)[^<]*/, `$1${cls.name}`)
    .replace(/(data-icon-alt="uczestnicy">)[^<]*/, `$1${cls.seatsTaken}/${cls.seatsTotal}`);
}

/**
 * A stand-in for the portal, rendering the real markup saved in fixtures/.
 * A POST on a not-open class returns the real refusal. The response for a full
 * class hasn't been seen yet, so that one is a guess.
 */
export class MockPortal {
  readonly requests: LoggedRequest[] = [];
  /** Added to each POST, to imitate the 5 s the real portal takes. */
  postDelayMs = 0;
  /** POSTs to these classes take effect, but the response never arrives. */
  readonly lostResponses = new Set<number>();
  /** Runs when a POST arrives, before it is handled. */
  onPost: ((path: string) => void | Promise<void>) | undefined;

  private readonly classes = new Map<number, MockClass>();
  private readonly sessions = new Map<string, MockSession>();
  private readonly rotations = new Map<string, string>();
  private anonymousCount = 0;
  private readonly now: () => number;
  private readonly server: http.Server;

  constructor(options: MockPortalOptions = {}) {
    this.now = options.now ?? Date.now;
    for (const cls of options.classes ?? []) this.classes.set(cls.id, cls);
    this.server = http.createServer((request, response) => {
      void this.handle(request, response);
    });
  }

  async start(): Promise<string> {
    await new Promise<void>((resolve) => this.server.listen(0, "127.0.0.1", resolve));
    return this.url;
  }

  get url(): string {
    return `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
  }

  async stop(): Promise<void> {
    this.server.closeAllConnections();
    await new Promise((resolve) => this.server.close(resolve));
  }

  addSession(cookieValue: string): void {
    this.sessions.set(cookieValue, { registerCore: newCore(), unregisterCore: newCore(), booked: new Set() });
  }

  endSession(cookieValue: string): void {
    this.sessions.delete(cookieValue);
  }

  /** The next response to this session moves it to a new cookie value, with Set-Cookie. */
  rotateSession(cookieValue: string, nextValue: string): void {
    this.rotations.set(cookieValue, nextValue);
  }

  isBooked(cookieValue: string, id: number): boolean {
    return this.sessions.get(cookieValue)?.booked.has(id) ?? false;
  }

  posts(): LoggedRequest[] {
    return this.requests.filter((request) => request.method === "POST");
  }

  private isOpen(cls: MockClass): boolean {
    const now = this.now();
    return now >= cls.opensAtMs && (cls.closedAtMs === undefined || now < cls.closedAtMs);
  }

  private classPage(cls: MockClass, session: MockSession): string {
    if (session.booked.has(cls.id)) return personalise(FIXTURE.booked, FIXTURE_IDS.booked, cls);
    if (!this.isOpen(cls)) return personalise(FIXTURE.notOpen, FIXTURE_IDS.notOpen, cls);
    return withToken(personalise(FIXTURE.open, FIXTURE_IDS.open, cls), "schedule_register_form", mask(session.registerCore));
  }

  /** Like the real portal: a logged-out visitor still gets a form with a token. */
  private anonymousClassPage(cls: MockClass): string {
    if (!this.isOpen(cls)) return personalise(FIXTURE.notOpen, FIXTURE_IDS.notOpen, cls).replace(/<header>[\s\S]*?<\/header>/, LOGIN_FORM);
    const page = personalise(FIXTURE.open, FIXTURE_IDS.open, cls).replace(/<header>[\s\S]*?<\/header>/, LOGIN_FORM);
    return withToken(page, "schedule_register_form", mask(newCore()));
  }

  private schedule(): string {
    const items = FIXTURE.schedule.match(/<li id="schedule-item-[\s\S]*?<\/li>/g) ?? [];
    const template = (test: (item: string) => boolean) => items.find(test) ?? "";
    const earlyItem = template((item) => item.includes("item-registration-early"));
    const openItem = template((item) => !/item-registration-/.test(item));
    const lateItem = template((item) => item.includes("item-registration-late"));
    const idOf = (item: string) => Number(item.match(/data-id="(\d+)"/)?.[1]);

    const rendered = [...this.classes.values()].map((cls) => {
      const now = this.now();
      const closed = cls.closedAtMs !== undefined && now >= cls.closedAtMs;
      const chosen = closed ? lateItem : this.isOpen(cls) ? openItem : earlyItem;
      return personalise(chosen, idOf(chosen), cls).replace(
        /data-full="\w+"/,
        `data-full="${cls.seatsTaken >= cls.seatsTotal}"`,
      );
    });
    return `<!doctype html><html lang="pl"><body>${LOGIN_FORM}<section id="schedule-rano"><ul>${rendered.join("\n")}</ul></section></body></html>`;
  }

  private async handle(request: http.IncomingMessage, response: http.ServerResponse): Promise<void> {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(chunk as Buffer);
    const path = request.url ?? "/";
    const cookie = /SULUSESSID=([^;]+)/.exec(request.headers.cookie ?? "")?.[1];
    this.requests.push({
      method: request.method ?? "GET",
      path,
      origin: request.headers.origin,
      referer: request.headers.referer,
      cookie: cookie !== undefined,
      at: this.now(),
    });
    const session = cookie ? this.sessions.get(cookie) : undefined;
    let setCookie: string | undefined;
    const rotated = cookie ? this.rotations.get(cookie) : undefined;
    if (cookie && session && rotated) {
      this.rotations.delete(cookie);
      this.sessions.delete(cookie);
      this.sessions.set(rotated, session);
      setCookie = `SULUSESSID=${rotated}; path=/; secure; httponly; samesite=lax`;
    } else if (cookie && !session) {
      // Like the real portal: an ended session gets a new anonymous cookie on its next request.
      setCookie = `SULUSESSID=anonymous-${++this.anonymousCount}; path=/; secure; httponly; samesite=lax`;
    }
    const send = (html: string, status = 200) => {
      response.writeHead(status, {
        "Content-Type": "text/html; charset=utf-8",
        Server: "mock-portal",
        ...(setCookie ? { "Set-Cookie": setCookie } : {}),
      });
      response.end(html);
    };

    if (request.method === "POST") {
      await this.onPost?.(path);
      const form = new URLSearchParams(Buffer.concat(chunks).toString());
      return this.handlePost(path, form, session, send);
    }

    const classMatch = /^\/kluby-fitness\/[a-z0-9-]+\/grafik-zajec\/(\d+)(\/zapisz)?$/.exec(path);
    if (path === "/zajecia") return send(session ? FIXTURE.open : LOGGED_OUT_PAGE);
    if (path === `/kluby-fitness/${CLUB}/grafik-zajec`) return send(this.schedule());
    if (!classMatch) return send("Not found", 404);

    const cls = this.classes.get(Number(classMatch[1]));
    if (!cls) return send("Not found", 404);
    if (!session) return send(this.anonymousClassPage(cls));
    if (classMatch[2] && session.booked.has(cls.id)) {
      const page = personalise(FIXTURE.unregister, FIXTURE_IDS.unregister, cls);
      return send(withToken(page, "schedule_unregister_form", mask(session.unregisterCore)));
    }
    return send(this.classPage(cls, session));
  }

  private async handlePost(
    path: string,
    form: URLSearchParams,
    session: MockSession | undefined,
    send: (html: string, status?: number) => void,
  ): Promise<void> {
    if (this.postDelayMs > 0) await new Promise((resolve) => setTimeout(resolve, this.postDelayMs));
    if (!session) return send(LOGGED_OUT_PAGE);

    const match = /^\/grafik-zajec\/(\d+)(\/wypisz)?$/.exec(path);
    const cls = this.classes.get(Number(match?.[1]));
    if (!match || !cls) return send("Not found", 404);

    const formName = match[2] ? "schedule_unregister_form" : "schedule_register_form";
    const expected = match[2] ? session.unregisterCore : session.registerCore;
    const valid = tokenCore(form.get(`${formName}[_token]`) ?? "") === expected;

    if (valid && match[2] && session.booked.delete(cls.id)) cls.seatsTaken--;
    if (valid && !match[2] && !session.booked.has(cls.id) && this.isOpen(cls) && cls.seatsTaken < cls.seatsTotal) {
      session.booked.add(cls.id);
      cls.seatsTaken++;
    }
    if (this.lostResponses.has(cls.id)) return;
    if (!match[2] && !session.booked.has(cls.id) && !this.isOpen(cls)) {
      return send(personalise(FIXTURE.postNotOpen, FIXTURE_IDS.postNotOpen, cls));
    }
    send(this.classPage(cls, session));
  }
}
