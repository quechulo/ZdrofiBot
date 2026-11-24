import { DEFAULT_USER_AGENT, PORTAL_ORIGIN } from "@zdrofibot/portal";

export interface SessionWorkerConfig {
  databaseUrl: string;
  /** Development only. Production unwraps data keys with KMS. */
  localKek: string;
  portalOrigin: string;
  userAgent: string;
  /** Without it, alerts are only logged. */
  telegramToken: string | null;
  telegramApiBase: string;
  /** Shown as a button on alerts once assisted login exists (M4). */
  reconnectUrl: string | null;
  /** Clubs to keep in the schedule copy besides the accounts' home clubs. */
  extraClubs: string[];
}

function required(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name];
  if (!value) throw new Error(`${name} is not set`);
  return value;
}

export function loadConfig(env: NodeJS.ProcessEnv): SessionWorkerConfig {
  return {
    databaseUrl: required(env, "DATABASE_URL"),
    localKek: required(env, "SECRETS_LOCAL_KEK"),
    portalOrigin: env.ZDROFIT_BASE_URL ?? PORTAL_ORIGIN,
    userAgent: env.PORTAL_USER_AGENT ?? DEFAULT_USER_AGENT,
    telegramToken: env.TELEGRAM_BOT_TOKEN || null,
    telegramApiBase: env.TELEGRAM_API_BASE ?? "https://api.telegram.org",
    reconnectUrl: env.RECONNECT_URL || null,
    extraClubs: (env.DISCOVERY_CLUBS ?? "")
      .split(",")
      .map((club) => club.trim())
      .filter(Boolean),
  };
}
