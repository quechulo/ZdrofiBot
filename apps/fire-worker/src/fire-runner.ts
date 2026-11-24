import type { ELDHistogram } from "node:perf_hooks";
import { PortalClient, PortalCookieJar, type ClassPage } from "@zdrofibot/portal";
import type { SessionVault } from "@zdrofibot/sessions";
import { Agent } from "undici";
import type { FireTimings } from "./config.js";
import type { ClaimedJob, FinalState, JobResult, JobStore } from "./job-store.js";
import { sleepUntil, type FireBarrier } from "./timing.js";

export interface Log {
  log(message: string): void;
  warn(message: string): void;
  error(message: string): void;
}

export interface RunnerDeps {
  store: JobStore;
  vault: SessionVault;
  barrier: FireBarrier;
  timings: FireTimings;
  portalOrigin: string;
  userAgent: string;
  log: Log;
  loopDelay?: ELDHistogram;
}

/** "fire" for a newly armed job. "recover" for one whose worker died mid-fire: it is only checked. */
export type RunnerMode = "fire" | "recover";

interface Prepared {
  accountId: string;
  client: PortalClient;
  agent: Agent;
  jar: PortalCookieJar;
  initialState: string;
  /** The stored session's version, so rotated cookies never overwrite a newer login. */
  version: number;
  /** Null when no open class gave one, so the target's own page is read at T. */
  token: string | null;
}

type PrepareFailure = "no-account" | "no-session" | "session-lost";

/** What has been sent so far, carried into the result. */
interface Attempt {
  posts: number;
  sentAt?: Date;
  /** A recovery check doesn't know what the dead worker sent, so it leaves these alone. */
  recovery: boolean;
}

type TargetRead = { token: string } | { result: FinalState; errorCode?: string };

const isAbort = (error: unknown) => error instanceof Error && error.name === "AbortError";
const describe = (error: unknown) => (error instanceof Error ? `${error.name}: ${error.message}` : "unknown error");

/** Runs one job from arming to its final state. Never logs cookies or tokens. */
export class FireRunner {
  readonly done: Promise<void>;
  private readonly abort = new AbortController();
  private phase: "waiting" | "firing" | "finished" = "waiting";
  private readonly opensAt: number;

  constructor(
    readonly job: ClaimedJob,
    private readonly mode: RunnerMode,
    private readonly deps: RunnerDeps,
  ) {
    this.opensAt = job.opensAt.getTime();
    this.done = this.run().catch((error: unknown) => this.crash(error));
  }

  private get t(): FireTimings {
    return this.deps.timings;
  }

  /** True near the send, when the engine holds back its own database writes. */
  isQuiet(now: number): boolean {
    if (this.mode === "recover" || this.phase === "finished") return false;
    return now >= this.opensAt - this.t.quietBeforeMs && now <= this.opensAt + this.t.quietAfterMs;
  }

  /** For shutdown. Hands the job back if it hasn't started firing. */
  release(): boolean {
    if (this.phase !== "waiting") return false;
    this.abort.abort();
    return true;
  }

  private sleepUntil(at: number): Promise<void> {
    return sleepUntil(at, this.abort.signal);
  }

  private async run(): Promise<void> {
    if (this.mode === "recover") return this.recover();
    const T = this.opensAt;
    if (Date.now() > T + this.t.lateLimitMs) {
      return this.finish({ state: "MISSED", errorCode: "late", postsSent: 0 });
    }

    await this.sleepUntil(T - this.t.prepareLeadMs);
    const prepared = await this.prepareUntil(T - this.t.lastReloadLeadMs);
    if (typeof prepared === "string") return this.finish({ state: "FAILED", errorCode: prepared, postsSent: 0 });

    try {
      void this.warmUp(prepared);
      await this.sleepUntil(T - this.t.firingLeadMs);
      if (this.abort.signal.aborted) throw new DOMException("Released", "AbortError");
      this.phase = "firing";
      const now = new Date();
      if (!(await this.deps.store.markFiring(this.job, new Date(T + this.t.firingLeaseMs), now))) {
        // Cancelled, moved or taken over. Nothing may be sent.
        this.phase = "finished";
        await this.deps.store.release(this.job.id, new Date());
        this.deps.log.warn(`Job ${this.job.id} changed before firing, so nothing was sent`);
        return;
      }

      await this.deps.barrier.wait(T + this.t.fireOffsetMs);
      this.deps.loopDelay?.reset();
      const result = await this.fire(prepared);
      await this.finish(result);
      if (result.errorCode !== "session-lost") await this.saveRotatedCookies(prepared);
    } finally {
      void prepared.agent.close();
    }
  }

  private async prepareUntil(deadline: number): Promise<Prepared | PrepareFailure> {
    let fallback: Prepared | null = null;
    for (;;) {
      const result = await this.prepareOnce();
      if (typeof result !== "string" && result.token !== null) {
        if (fallback) void fallback.agent.close();
        return result;
      }
      if (fallback) void fallback.agent.close();
      fallback = typeof result === "string" ? null : result;

      if (Date.now() + this.t.prepareRetryMs > deadline) return fallback ?? (result as PrepareFailure);
      this.deps.log.warn(`Job ${this.job.id} not ready (${fallback ? "no token" : result}), retrying`);
      await this.sleepUntil(Date.now() + this.t.prepareRetryMs);
    }
  }

  /** Loads the session from the database each time, so a reconnect before T is picked up. */
  private async prepareOnce(): Promise<Prepared | PrepareFailure> {
    const { vault, store } = this.deps;
    const account = await vault.accountForUser(this.job.userId);
    if (!account) return "no-account";
    const session = await vault.loadSession(account.id);
    if (!session) return "no-session";
    const jar = new PortalCookieJar(new URL(this.deps.portalOrigin).hostname, session.state);
    if (!jar.hasSession()) return "no-session";

    const agent = new Agent({
      keepAliveTimeout: 60_000,
      keepAliveMaxTimeout: 120_000,
      connect: { timeout: this.t.connectTimeoutMs },
    });
    const client = new PortalClient({
      userAgent: this.deps.userAgent,
      origin: this.deps.portalOrigin,
      jar,
      dispatcher: agent,
    });
    const prepared: Prepared = {
      accountId: account.id,
      client,
      agent,
      jar,
      initialState: JSON.stringify(jar.toState()),
      version: session.version,
      token: null,
    };
    const lost = (): PrepareFailure => {
      void agent.close();
      return "session-lost";
    };

    // Too late for another class's token. The target is open, so its own page has one.
    if (Date.now() >= this.opensAt) return prepared;

    for (const source of await store.tokenSources(this.job, new Date())) {
      let page: ClassPage;
      try {
        page = await client.fetchClassPage(source.clubSlug, source.id);
      } catch {
        continue;
      }
      if (page.session === "logged-out") return lost();
      // A logged-out page offers a token too, so only trust one from a logged-in page.
      if (page.session === "authenticated" && page.registerToken) return { ...prepared, token: page.registerToken };
    }

    try {
      if ((await client.checkSession()) === "logged-out") return lost();
    } catch {
      // The portal is unreachable now. Try again at T anyway.
    }
    return prepared;
  }

  private async warmUp(prepared: Prepared): Promise<void> {
    try {
      if (Date.now() >= this.opensAt - this.t.warmLeadMs) return;
      await this.sleepUntil(this.opensAt - this.t.warmLeadMs);
      const state = await prepared.client.checkSession(this.t.warmTimeoutMs);
      if (state === "logged-out") this.deps.log.warn(`Job ${this.job.id}: session ended just before T`);
    } catch {
      // A slow or failed warm-up only means the send opens its own connection.
    }
  }

  private result(attempt: Attempt, state: FinalState, errorCode?: string): JobResult {
    if (attempt.recovery) return { state, ...(errorCode ? { errorCode } : {}) };
    return {
      state,
      ...(errorCode ? { errorCode } : {}),
      ...(attempt.sentAt ? { sentAt: attempt.sentAt } : {}),
      confirmedAt: new Date(),
      postsSent: attempt.posts,
    };
  }

  private async fire(prepared: Prepared): Promise<JobResult> {
    const { client } = prepared;
    const { clubSlug, portalActivityId: id } = this.job;
    const attempt: Attempt = { posts: 0, recovery: false };
    let token = prepared.token;

    if (!token) {
      const read = await this.readTargetToken(client);
      if ("result" in read) return this.result(attempt, read.result, read.errorCode);
      token = read.token;
    }

    for (;;) {
      const started = Date.now();
      attempt.sentAt ??= new Date(started);
      const response = await client.register(clubSlug, id, token, this.t.postTimeoutMs);
      attempt.posts++;
      switch (response.outcome) {
        case "booked":
          return this.result(attempt, "BOOKED");
        case "closed":
          return this.result(attempt, "FAILED", "closed");
        case "session-lost":
          return this.result(attempt, "FAILED", "session-lost");
        case "not-open":
          if (attempt.posts >= this.t.maxPosts || Date.now() >= this.opensAt + this.t.retryWindowMs) {
            return this.result(attempt, "FAILED", "not-open");
          }
          await sleepUntil(started + this.t.minRetryGapMs);
          continue;
        default:
          // No answer, or one we can't read. The POST may still have worked.
          this.deps.log.warn(`Job ${this.job.id}: ${response.outcome} after ${response.elapsedMs} ms, checking`);
          await this.deps.store.markVerifying(this.job.id, new Date());
          return this.verify(client, attempt);
      }
    }
  }

  /** GET then POST, for when no token was found before T. Reads are spaced and bounded. */
  private async readTargetToken(client: PortalClient): Promise<TargetRead> {
    const deadline = Math.max(Date.now(), this.opensAt) + this.t.retryWindowMs;
    let reachable = false;
    for (;;) {
      try {
        const page = await client.fetchClassPage(this.job.clubSlug, this.job.portalActivityId);
        reachable = true;
        if (page.session === "logged-out") return { result: "FAILED", errorCode: "session-lost" };
        if (page.memberRegistered) return { result: "BOOKED" };
        if (page.window === "closed") return { result: "FAILED", errorCode: "closed" };
        if (page.session === "authenticated" && page.registerToken) return { token: page.registerToken };
      } catch {
        // Try again until the deadline.
      }
      if (Date.now() + this.t.minRetryGapMs > deadline) {
        return { result: "FAILED", errorCode: reachable ? "no-token" : "no-response" };
      }
      await sleepUntil(Date.now() + Math.max(this.t.minRetryGapMs, 1_000));
    }
  }

  /**
   * Reads the class page from the same session, which shows its own booking at once.
   * If the class is open with seats left and still not booked, one more POST is
   * safe: the portal returns the same page for a repeat and books nothing twice.
   * A recovery never sends, because it can't know what the dead worker sent.
   */
  private async verify(client: PortalClient, attempt: Attempt): Promise<JobResult> {
    let lastCode = "unverified";
    for (let check = 0; check < this.t.verifyAttempts; check++) {
      if (check > 0) await sleepUntil(Date.now() + this.t.verifyGapMs);
      let page: ClassPage;
      try {
        page = await client.fetchClassPage(this.job.clubSlug, this.job.portalActivityId);
      } catch {
        continue;
      }
      if (page.session === "logged-out") return this.result(attempt, "FAILED", "session-lost");
      if (page.session !== "authenticated") continue;
      if (page.memberRegistered) return this.result(attempt, "BOOKED");
      if (page.seatsTaken !== null && page.seatsTotal !== null && page.seatsTaken >= page.seatsTotal) {
        return this.result(attempt, "FULL");
      }
      if (page.window !== "open") return this.result(attempt, "FAILED", page.window);

      const canSend =
        !attempt.recovery &&
        page.registerToken !== null &&
        attempt.posts < this.t.maxPosts &&
        Date.now() < this.opensAt + this.t.repostWindowMs;
      if (!canSend) return this.result(attempt, "FAILED", attempt.recovery ? "interrupted" : "not-booked");

      const response = await client.register(
        this.job.clubSlug,
        this.job.portalActivityId,
        page.registerToken!,
        this.t.postTimeoutMs,
      );
      attempt.posts++;
      if (response.outcome === "booked") return this.result(attempt, "BOOKED");
      if (response.outcome === "session-lost") return this.result(attempt, "FAILED", "session-lost");
      if (response.outcome === "closed") return this.result(attempt, "FAILED", "closed");
      lastCode = response.outcome;
    }
    return this.result(attempt, "FAILED", lastCode);
  }

  private async recover(): Promise<void> {
    // Past the point of no return already, so a crash here is final rather than retried.
    this.phase = "firing";
    this.deps.log.warn(`Job ${this.job.id} was interrupted mid-fire. Checking, never resending`);
    const prepared = await this.prepareSessionOnly();
    if (typeof prepared === "string") {
      return this.finish({ state: "FAILED", errorCode: `interrupted-${prepared}` });
    }
    try {
      await this.finish(await this.verify(prepared.client, { posts: 0, recovery: true }));
    } finally {
      void prepared.agent.close();
    }
  }

  private async prepareSessionOnly(): Promise<Prepared | PrepareFailure> {
    const { vault } = this.deps;
    const account = await vault.accountForUser(this.job.userId);
    if (!account) return "no-account";
    const session = await vault.loadSession(account.id);
    if (!session) return "no-session";
    const jar = new PortalCookieJar(new URL(this.deps.portalOrigin).hostname, session.state);
    const agent = new Agent({ connect: { timeout: this.t.connectTimeoutMs } });
    const client = new PortalClient({ userAgent: this.deps.userAgent, origin: this.deps.portalOrigin, jar, dispatcher: agent });
    const initialState = JSON.stringify(jar.toState());
    return { accountId: account.id, client, agent, jar, initialState, version: session.version, token: null };
  }

  /** A rotated SULUSESSID must be stored, or the next request sends a dead session. */
  private async saveRotatedCookies(prepared: Prepared): Promise<void> {
    const state = prepared.jar.toState();
    if (JSON.stringify(state) === prepared.initialState) return;
    if (!(await this.deps.vault.saveStorageState(prepared.accountId, state, prepared.version))) {
      this.deps.log.warn(`Job ${this.job.id}: a newer login was stored meanwhile, so rotated cookies were dropped`);
    }
  }

  private async finish(result: JobResult): Promise<void> {
    this.phase = "finished";
    await this.deps.store.finish(this.job, result, new Date());
    const parts = [
      `Job ${this.job.id} class ${this.job.portalActivityId}: ${result.state}`,
      result.errorCode ? `(${result.errorCode})` : "",
      result.postsSent === undefined ? "" : `posts=${result.postsSent}`,
      result.sentAt ? `sent=T${result.sentAt.getTime() - this.opensAt >= 0 ? "+" : ""}${result.sentAt.getTime() - this.opensAt}ms` : "",
      result.sentAt && result.confirmedAt ? `confirmed=${result.confirmedAt.getTime() - result.sentAt.getTime()}ms` : "",
      this.deps.loopDelay && result.sentAt ? `loopDelayMax=${Math.round(this.deps.loopDelay.max / 1e6)}ms` : "",
    ];
    this.deps.log.log(parts.filter(Boolean).join(" "));
  }

  private async crash(error: unknown): Promise<void> {
    const wasWaiting = this.phase === "waiting";
    this.phase = "finished";
    try {
      if (wasWaiting) {
        // Nothing was sent, so another tick can arm it again.
        await this.deps.store.release(this.job.id, new Date());
        if (!isAbort(error)) this.deps.log.error(`Job ${this.job.id} released after ${describe(error)}`);
        return;
      }
      // Something may have been sent, so this must never be retried.
      this.deps.log.error(`Job ${this.job.id} failed mid-fire: ${describe(error)}`);
      await this.deps.store.finish(this.job, { state: "FAILED", errorCode: "internal" }, new Date());
    } catch (inner) {
      this.deps.log.error(`Job ${this.job.id}: could not record the failure: ${describe(inner)}`);
    }
  }
}
