import os from "node:os";
import { PORTAL_ORIGIN } from "@zdrofibot/portal";

/** Every duration the engine uses, so tests can run the same timeline in about a second. */
export interface FireTimings {
  /** How far ahead a job is claimed. */
  armLeadMs: number;
  armIntervalMs: number;
  leaseMs: number;
  renewIntervalMs: number;
  /** When to load the session and fetch a token from another open class. */
  prepareLeadMs: number;
  prepareRetryMs: number;
  /** The last moment to reload the session from the database, e.g. after a reconnect. */
  lastReloadLeadMs: number;
  /** Opens a fresh connection just before T, in case the earlier one went idle. */
  warmLeadMs: number;
  warmTimeoutMs: number;
  /** The FIRING write. Nothing touches the database after this until the response. */
  firingLeadMs: number;
  firingLeaseMs: number;
  /** Lease renewals pause in this window around T, so nothing competes with the send. */
  quietBeforeMs: number;
  quietAfterMs: number;
  /** Added to T. Zero until real openings show the portal's clock is ahead or behind. */
  fireOffsetMs: number;
  connectTimeoutMs: number;
  postTimeoutMs: number;
  /** Booking POSTs per job. A repeat is harmless, but each takes about 5 s. */
  maxPosts: number;
  /** "Not open yet" is retried until T plus this. */
  retryWindowMs: number;
  minRetryGapMs: number;
  verifyAttempts: number;
  verifyGapMs: number;
  /** After checking the class page, one more POST may be sent until T plus this. */
  repostWindowMs: number;
  /** A job found later than this after T is MISSED instead of fired. */
  lateLimitMs: number;
  /** On shutdown, jobs further away than this are released for another worker. */
  drainKeepMs: number;
}

export const DEFAULT_TIMINGS: FireTimings = {
  armLeadMs: 10 * 60_000,
  armIntervalMs: 30_000,
  leaseMs: 45_000,
  renewIntervalMs: 15_000,
  prepareLeadMs: 60_000,
  prepareRetryMs: 10_000,
  lastReloadLeadMs: 3_000,
  warmLeadMs: 5_000,
  warmTimeoutMs: 3_000,
  firingLeadMs: 2_000,
  firingLeaseMs: 90_000,
  quietBeforeMs: 3_000,
  quietAfterMs: 1_000,
  fireOffsetMs: 0,
  connectTimeoutMs: 3_000,
  postTimeoutMs: 15_000,
  maxPosts: 3,
  retryWindowMs: 20_000,
  minRetryGapMs: 300,
  verifyAttempts: 3,
  verifyGapMs: 5_000,
  repostWindowMs: 60_000,
  lateLimitMs: 2 * 60_000,
  drainKeepMs: 2 * 60_000,
};

export interface FireConfig {
  workerId: string;
  databaseUrl: string;
  /** Development only. Production unwraps data keys with KMS. */
  localKek: string;
  portalOrigin: string;
  userAgent: string;
  timings: FireTimings;
}

const DEFAULT_USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36";

function required(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name];
  if (!value) throw new Error(`${name} is not set`);
  return value;
}

export function loadConfig(env: NodeJS.ProcessEnv): FireConfig {
  return {
    workerId: env.WORKER_ID ?? `fire-${os.hostname()}`,
    databaseUrl: required(env, "DATABASE_URL"),
    localKek: required(env, "SECRETS_LOCAL_KEK"),
    portalOrigin: env.ZDROFIT_BASE_URL ?? PORTAL_ORIGIN,
    userAgent: env.PORTAL_USER_AGENT ?? DEFAULT_USER_AGENT,
    timings: DEFAULT_TIMINGS,
  };
}
