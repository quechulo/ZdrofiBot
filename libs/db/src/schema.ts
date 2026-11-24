import { JOB_STATES } from "@zdrofibot/scheduling";
import { sql } from "drizzle-orm";
import {
  bigserial,
  boolean,
  customType,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

const bytea = customType<{ data: Buffer }>({ dataType: () => "bytea" });
const moment = (name: string) => timestamp(name, { withTimezone: true });
const createdAt = () => moment("created_at").notNull().defaultNow();

export const userRole = pgEnum("user_role", ["admin", "user"]);
export const userStatus = pgEnum("user_status", ["active", "disabled"]);
export const secretKind = pgEnum("secret_kind", ["password", "storage_state", "register_token"]);
export const portalSessionState = pgEnum("portal_session_state", ["ACTIVE", "REFRESHING", "NEEDS_USER", "FAILED"]);
export const registrationWindow = pgEnum("registration_window", ["not-open", "open", "closed"]);
export const jobState = pgEnum("job_state", JOB_STATES);

export const users = pgTable("users", {
  id: uuid("id").primaryKey().defaultRandom(),
  displayName: text("display_name").notNull(),
  email: text("email"),
  role: userRole("role").notNull().default("user"),
  status: userStatus("status").notNull().default("active"),
  telegramChatId: text("telegram_chat_id"),
  createdAt: createdAt(),
});

export const accessTokens = pgTable("access_tokens", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  tokenHash: text("token_hash").notNull().unique(),
  /** Eight characters of the random part, because "ar_live_" says nothing. */
  prefix: text("prefix").notNull(),
  label: text("label").notNull(),
  expiresAt: moment("expires_at"),
  lastUsedAt: moment("last_used_at"),
  revokedAt: moment("revoked_at"),
  createdAt: createdAt(),
});

export const webSessions = pgTable("web_sessions", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  expiresAt: moment("expires_at").notNull(),
  createdIp: text("created_ip"),
  userAgent: text("user_agent"),
  revokedAt: moment("revoked_at"),
  createdAt: createdAt(),
});

export const portalAccounts = pgTable("portal_accounts", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: uuid("user_id").notNull().unique().references(() => users.id, { onDelete: "cascade" }),
  login: text("login").notNull(),
  homeClubSlug: text("home_club_slug").notNull(),
  createdAt: createdAt(),
});

/** Ciphertext only, in its own table so the API role can be denied SELECT on it. */
export const secretBlobs = pgTable(
  "secret_blobs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    portalAccountId: uuid("portal_account_id").notNull().references(() => portalAccounts.id, { onDelete: "cascade" }),
    kind: secretKind("kind").notNull(),
    ciphertext: bytea("ciphertext").notNull(),
    nonce: bytea("nonce").notNull(),
    /** Each secret has its own data key, wrapped by KMS. */
    wrappedDek: bytea("wrapped_dek").notNull(),
    /** Bumped on every write, so a worker never overwrites a newer login with older cookies. */
    version: integer("version").notNull().default(1),
    updatedAt: moment("updated_at").notNull().defaultNow(),
  },
  (table) => [uniqueIndex("secret_blobs_account_kind").on(table.portalAccountId, table.kind)],
);

export const portalSessions = pgTable("portal_sessions", {
  id: uuid("id").primaryKey().defaultRandom(),
  portalAccountId: uuid("portal_account_id").notNull().unique().references(() => portalAccounts.id, { onDelete: "cascade" }),
  state: portalSessionState("state").notNull().default("NEEDS_USER"),
  loggedInAt: moment("logged_in_at"),
  lastOkAt: moment("last_ok_at"),
  failureCount: integer("failure_count").notNull().default(0),
  updatedAt: moment("updated_at").notNull().defaultNow(),
});

/**
 * One row per session that ended, so the lifetime question can be answered from
 * real data: it died somewhere between last_ok_at and ended_at.
 */
export const sessionEnds = pgTable(
  "session_ends",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    portalAccountId: uuid("portal_account_id").notNull().references(() => portalAccounts.id, { onDelete: "cascade" }),
    loggedInAt: moment("logged_in_at"),
    lastOkAt: moment("last_ok_at"),
    endedAt: moment("ended_at").notNull(),
    reason: text("reason").notNull(),
  },
  (table) => [index("session_ends_account").on(table.portalAccountId, table.endedAt)],
);

/** One-time codes behind the Telegram Start link. Stored hashed. */
export const telegramLinkCodes = pgTable("telegram_link_codes", {
  codeHash: text("code_hash").primaryKey(),
  userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  expiresAt: moment("expires_at").notNull(),
  usedAt: moment("used_at"),
  createdAt: createdAt(),
});

/** Worker-maintained copy of the schedule. The API never calls the portal. */
export const portalActivities = pgTable(
  "portal_activities",
  {
    id: integer("id").primaryKey(),
    clubSlug: text("club_slug").notNull(),
    name: text("name").notNull(),
    startsAt: moment("starts_at").notNull(),
    opensAt: moment("opens_at").notNull(),
    window: registrationWindow("window").notNull(),
    full: boolean("full").notNull().default(false),
    seatsTaken: integer("seats_taken"),
    seatsTotal: integer("seats_total"),
    lastSeenAt: moment("last_seen_at").notNull().defaultNow(),
  },
  (table) => [index("portal_activities_club_start").on(table.clubSlug, table.startsAt)],
);

export const registrationRules = pgTable("registration_rules", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  matcher: jsonb("matcher").notNull(),
  enabled: boolean("enabled").notNull().default(true),
  createdAt: createdAt(),
});

export const registrationJobs = pgTable(
  "registration_jobs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    ruleId: uuid("rule_id").references(() => registrationRules.id, { onDelete: "set null" }),
    portalActivityId: integer("portal_activity_id").notNull().references(() => portalActivities.id),
    opensAt: moment("opens_at").notNull(),
    state: jobState("state").notNull().default("SCHEDULED"),
    workerId: text("worker_id"),
    leaseUntil: moment("lease_until"),
    sentAt: moment("sent_at"),
    confirmedAt: moment("confirmed_at"),
    /** sent_at minus opens_at: how accurately the job fired. */
    sendLatencyMs: integer("send_latency_ms"),
    /** Booking POSTs sent. The portal treats a repeat as a no-op, but each costs about 5 s. */
    postsSent: integer("posts_sent").notNull().default(0),
    errorCode: text("error_code"),
    createdAt: createdAt(),
    updatedAt: moment("updated_at").notNull().defaultNow(),
  },
  (table) => [
    // Excludes CANCELLED so a class can be booked again after cancelling.
    uniqueIndex("registration_jobs_one_per_class")
      .on(table.userId, table.portalActivityId)
      .where(sql`${table.state} <> 'CANCELLED'`),
    index("registration_jobs_due").on(table.state, table.opensAt),
  ],
);

/** The unique key stops a restart from resending an alert rung. */
export const notifications = pgTable(
  "notifications",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    portalAccountId: uuid("portal_account_id").notNull().references(() => portalAccounts.id, { onDelete: "cascade" }),
    jobId: uuid("job_id").notNull().references(() => registrationJobs.id, { onDelete: "cascade" }),
    rung: text("rung").notNull(),
    channel: text("channel").notNull(),
    sentAt: moment("sent_at").notNull().defaultNow(),
  },
  (table) => [uniqueIndex("notifications_once").on(table.portalAccountId, table.jobId, table.rung)],
);

export const workerHeartbeats = pgTable("worker_heartbeats", {
  worker: text("worker").notNull(),
  beatAt: moment("beat_at").notNull().defaultNow(),
}, (table) => [primaryKey({ columns: [table.worker] })]);

/** Records who did what. Never store secrets or portal content here. */
export const auditLog = pgTable("audit_log", {
  id: bigserial("id", { mode: "number" }).primaryKey(),
  actorId: uuid("actor_id").references(() => users.id, { onDelete: "set null" }),
  action: text("action").notNull(),
  target: text("target"),
  ip: text("ip"),
  at: moment("at").notNull().defaultNow(),
});
