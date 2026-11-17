import { fetch, type Dispatcher } from "undici";
import type { PortalCookieJar } from "./cookies.js";
import {
  classifyRegistration,
  classifySession,
  classifyUnregistration,
  parseClassPage,
  parseSchedule,
  type ClassPage,
  type RegistrationOutcome,
  type ScheduleItem,
  type SessionState,
} from "./parsing.js";
import { PORTAL_ORIGIN, portalPaths } from "./paths.js";

const MAX_REDIRECTS = 5;
const DEFAULT_TIMEOUT_MS = 15_000;

export interface PortalClientOptions {
  userAgent: string;
  origin?: string;
  /** Absent for anonymous reads such as the public schedule. */
  jar?: PortalCookieJar;
  /** One keep-alive agent per user, so connections can be opened before T. */
  dispatcher?: Dispatcher;
}

export interface PortalResponse {
  status: number;
  url: string;
  html: string;
  elapsedMs: number;
}

interface RequestOptions {
  method?: "GET" | "POST";
  form?: Record<string, string>;
  headers?: Record<string, string>;
  timeoutMs?: number;
}

export type SubmitOutcome<T extends string> = T | "no-response";

export interface SubmitResult<T extends string> {
  outcome: SubmitOutcome<T>;
  elapsedMs: number;
}

/** Sends each write once. A retry is a decision for the caller, never this class. */
export class PortalClient {
  private readonly origin: string;

  constructor(private readonly options: PortalClientOptions) {
    this.origin = options.origin ?? PORTAL_ORIGIN;
  }

  private async request(path: string, options: RequestOptions = {}): Promise<PortalResponse> {
    const { jar, dispatcher, userAgent } = this.options;
    const signal = AbortSignal.timeout(options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    const started = performance.now();
    let url = new URL(path, this.origin).href;
    let method = options.method ?? "GET";
    let body = options.form ? new URLSearchParams(options.form).toString() : undefined;

    for (let hop = 0; ; hop++) {
      const cookie = jar?.header();
      const response = await fetch(url, {
        method,
        body,
        redirect: "manual",
        signal,
        ...(dispatcher ? { dispatcher } : {}),
        headers: {
          "User-Agent": userAgent,
          Accept: "text/html,application/xhtml+xml,*/*;q=0.8",
          "Accept-Language": "pl-PL,pl;q=0.9,en-US;q=0.8,en;q=0.7",
          ...(body ? { "Content-Type": "application/x-www-form-urlencoded" } : {}),
          ...(cookie ? { Cookie: cookie } : {}),
          ...options.headers,
        },
      });

      for (const setCookie of response.headers.getSetCookie()) jar?.apply(setCookie);

      const location = response.headers.get("location");
      const redirected = response.status >= 300 && response.status < 400 && location !== null;
      if (!redirected || hop >= MAX_REDIRECTS) {
        return {
          status: response.status,
          url,
          html: await response.text(),
          elapsedMs: Math.round(performance.now() - started),
        };
      }
      await response.arrayBuffer();
      url = new URL(location, url).href;
      if ([301, 302, 303].includes(response.status)) {
        method = "GET";
        body = undefined;
      }
    }
  }

  async checkSession(timeoutMs?: number): Promise<SessionState> {
    return classifySession(await this.request(portalPaths.sessionCheck, timeoutMs === undefined ? {} : { timeoutMs }));
  }

  async fetchSchedule(clubSlug: string): Promise<ScheduleItem[]> {
    return parseSchedule((await this.request(portalPaths.schedule(clubSlug))).html);
  }

  async fetchClassPage(clubSlug: string, id: number): Promise<ClassPage> {
    return parseClassPage(await this.request(portalPaths.classPage(clubSlug, id)), id);
  }

  async fetchUnregisterPage(clubSlug: string, id: number): Promise<ClassPage> {
    return parseClassPage(await this.request(portalPaths.unregisterPage(clubSlug, id)), id);
  }

  private async submit<T extends string>(
    path: string,
    form: Record<string, string>,
    referer: string,
    classify: (page: PortalResponse) => T,
    timeoutMs?: number,
  ): Promise<SubmitResult<T>> {
    const started = performance.now();
    try {
      const page = await this.request(path, {
        method: "POST",
        form,
        ...(timeoutMs === undefined ? {} : { timeoutMs }),
        headers: { Origin: new URL(this.origin).origin, Referer: new URL(referer, this.origin).href },
      });
      return { outcome: classify(page), elapsedMs: page.elapsedMs };
    } catch {
      // The request may still have reached the portal, so this is not a failure.
      return { outcome: "no-response", elapsedMs: Math.round(performance.now() - started) };
    }
  }

  register(clubSlug: string, id: number, token: string, timeoutMs?: number): Promise<SubmitResult<RegistrationOutcome>> {
    return this.submit(
      portalPaths.register(id),
      {
        "schedule_register_form[id]": String(id),
        "schedule_register_form[_redirect]": "",
        "schedule_register_form[_token]": token,
      },
      portalPaths.classPage(clubSlug, id),
      (page) => classifyRegistration(page, id),
      timeoutMs,
    );
  }

  unregister(clubSlug: string, id: number, token: string, timeoutMs?: number) {
    return this.submit(
      portalPaths.unregister(id),
      {
        "schedule_unregister_form[id]": String(id),
        "schedule_unregister_form[_redirect]": "",
        "schedule_unregister_form[_token]": token,
      },
      portalPaths.unregisterPage(clubSlug, id),
      (page) => classifyUnregistration(page, id),
      timeoutMs,
    );
  }
}
