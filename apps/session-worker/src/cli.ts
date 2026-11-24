// Admin commands until the web UI exists (M5). Run with:
//   pnpm cli <command> [options]
import fs from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import {
  createDb,
  migrateDatabase,
  portalAccounts,
  portalActivities,
  portalSessions,
  registrationJobs,
  sessionEnds,
  users,
  type AnyDatabase,
} from "@zdrofibot/db";
import type { StoredState } from "@zdrofibot/portal";
import { PORTAL_TIME_ZONE } from "@zdrofibot/scheduling";
import { and, asc, desc, eq, gt, ilike, inArray, lte, sql } from "drizzle-orm";
import { loadConfig } from "./config.js";
import { findActivity } from "./discovery.js";
import type { Log } from "./log.js";
import { buildServices } from "./services.js";

const HELP = `Commands:
  migrate                                   apply database migrations
  add-user --name <n> --login <email> --club <slug>
  import-session --recon <name> [--user <id>]   store a session from recon/login.mjs
  import-session --state <file> [--logged-in-at <iso>] [--user <id>]
  status                                    sessions and recorded session lifetimes
  discover                                  refresh the class list now
  classes [--club <slug>] [--days 3] [--search <text>]
  add-job --class <id> [--user <id>]
  jobs [--user <id>]
  cancel-job --job <id or prefix>
  telegram-link [--user <id>]               one-time link to bind your Telegram chat`;

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: {
    name: { type: "string" },
    login: { type: "string" },
    club: { type: "string" },
    recon: { type: "string" },
    state: { type: "string" },
    "logged-in-at": { type: "string" },
    user: { type: "string" },
    days: { type: "string" },
    search: { type: "string" },
    class: { type: "string" },
    job: { type: "string" },
  },
});

const log: Log = { log: console.log, warn: console.warn, error: console.error };
const fail = (message: string): never => {
  console.error(message);
  process.exit(1);
};

const warsaw = new Intl.DateTimeFormat("en-GB", {
  timeZone: PORTAL_TIME_ZONE,
  weekday: "short",
  day: "2-digit",
  month: "short",
  hour: "2-digit",
  minute: "2-digit",
});
const when = (date: Date | null) => (date ? warsaw.format(date) : "-");

/** pnpm runs scripts from the package folder, so relative paths start where pnpm was run. */
const fromInvocation = (file: string) => path.resolve(process.env.INIT_CWD ?? process.cwd(), file);
const reconOut = new URL("../../../recon/.out/", import.meta.url);

async function resolveUser(db: AnyDatabase): Promise<string> {
  if (values.user) return values.user;
  const all = await db.select({ id: users.id }).from(users).limit(2);
  if (all.length === 1) return all[0]!.id;
  return fail(all.length === 0 ? "No users yet. Run add-user first." : "Several users exist. Pass --user <id>.");
}

async function accountFor(db: AnyDatabase, userId: string) {
  const [account] = await db.select().from(portalAccounts).where(eq(portalAccounts.userId, userId));
  return account ?? fail(`User ${userId} has no portal account. Run add-user first.`);
}

/** Only the portal's cookies are kept. Google's and the trackers' aren't needed to book. */
function portalCookiesOnly(state: StoredState, host: string): StoredState {
  const cookies = state.cookies.filter((cookie) => {
    const bare = cookie.domain.replace(/^\./, "");
    return host === bare || host.endsWith(`.${bare}`);
  });
  if (!cookies.some((cookie) => cookie.name === "SULUSESSID")) fail("That state file has no portal session cookie.");
  return { cookies, origins: [] };
}

async function main() {
  const [command] = positionals;
  if (!command || command === "help") return console.log(HELP);
  const config = loadConfig(process.env);
  if (command === "migrate") {
    await migrateDatabase(config.databaseUrl);
    return console.log("Migrations applied.");
  }

  const { db, pool } = createDb(config.databaseUrl);
  const services = buildServices(db, config, log);
  try {
    switch (command) {
      case "add-user": {
        if (!values.name || !values.login || !values.club) fail("add-user needs --name, --login and --club.");
        const [user] = await db.insert(users).values({ displayName: values.name!, role: "admin" }).returning();
        await db.insert(portalAccounts).values({ userId: user!.id, login: values.login!, homeClubSlug: values.club! });
        console.log(`User ${user!.id} created.`);
        break;
      }

      case "import-session": {
        const userId = await resolveUser(db);
        const account = await accountFor(db, userId);
        const statePath = values.recon ? new URL(`state-${values.recon}.json`, reconOut) : fromInvocation(values.state ?? fail("Pass --recon <name> or --state <file>."));
        const raw = JSON.parse(fs.readFileSync(statePath, "utf8")) as StoredState;
        let loggedInAt = values["logged-in-at"] ? new Date(values["logged-in-at"]) : null;
        if (!loggedInAt && values.recon) {
          const meta = new URL(`meta-${values.recon}.json`, reconOut);
          if (fs.existsSync(meta)) loggedInAt = new Date((JSON.parse(fs.readFileSync(meta, "utf8")) as { loggedInAt: string }).loggedInAt);
        }
        if (!loggedInAt || Number.isNaN(loggedInAt.getTime())) fail("Unknown login time. Pass --logged-in-at <iso>.");
        const state = portalCookiesOnly(raw, new URL(config.portalOrigin).hostname);
        await services.vault.storeLogin(account.id, state, loggedInAt!);
        const outcome = await services.keepAlive.checkAccount(account.id);
        console.log(`Session stored (logged in ${when(loggedInAt)}). Check: ${outcome}.`);
        if (outcome === "ended") process.exitCode = 1;
        break;
      }

      case "status": {
        const sessions = await db
          .select({ login: portalAccounts.login, state: portalSessions.state, loggedInAt: portalSessions.loggedInAt, lastOkAt: portalSessions.lastOkAt, failures: portalSessions.failureCount, chat: users.telegramChatId })
          .from(portalAccounts)
          .innerJoin(users, eq(users.id, portalAccounts.userId))
          .leftJoin(portalSessions, eq(portalSessions.portalAccountId, portalAccounts.id));
        for (const row of sessions) {
          console.log(`${row.login}: ${row.state ?? "no session"}, logged in ${when(row.loggedInAt)}, last ok ${when(row.lastOkAt)}, failed checks ${row.failures ?? 0}, Telegram ${row.chat ? "linked" : "not linked"}`);
        }
        const ends = await db.select().from(sessionEnds).orderBy(desc(sessionEnds.endedAt)).limit(10);
        if (ends.length > 0) console.log("\nSession lifetimes (died between last ok and ended):");
        for (const end of ends) {
          const hours = (date: Date | null) => (date && end.loggedInAt ? ((date.getTime() - end.loggedInAt.getTime()) / 3_600_000).toFixed(1) : "?");
          console.log(`  logged in ${when(end.loggedInAt)}: alive at ${hours(end.lastOkAt)} h, dead by ${hours(end.endedAt)} h (${end.reason})`);
        }
        break;
      }

      case "discover":
        await services.discovery.run();
        break;

      case "classes": {
        const now = new Date();
        const days = Number(values.days ?? 3);
        const rows = await db
          .select()
          .from(portalActivities)
          .where(
            and(
              gt(portalActivities.startsAt, now),
              lte(portalActivities.startsAt, new Date(now.getTime() + days * 86_400_000)),
              values.club ? eq(portalActivities.clubSlug, values.club) : undefined,
              values.search ? ilike(portalActivities.name, `%${values.search}%`) : undefined,
            ),
          )
          .orderBy(asc(portalActivities.startsAt));
        if (rows.length === 0) console.log("No classes. Run discover, or widen --days.");
        for (const row of rows) {
          const seats = row.seatsTotal === null ? "" : ` ${row.seatsTaken}/${row.seatsTotal}`;
          console.log(`${row.id}  ${when(row.startsAt)}  opens ${when(row.opensAt)}  ${row.window.padEnd(8)}${seats}  ${row.name}`);
        }
        break;
      }

      case "add-job": {
        const userId = await resolveUser(db);
        await accountFor(db, userId);
        const activity = (await findActivity(db, Number(values.class ?? fail("Pass --class <id>.")))) ?? fail("Unknown class. Run discover first.");
        if (activity.opensAt.getTime() <= Date.now()) fail("Registration for this class is already open. Book it on the website.");
        const [job] = await db.insert(registrationJobs).values({ userId, portalActivityId: activity.id, opensAt: activity.opensAt }).returning();
        console.log(`Job ${job!.id} added: ${activity.name}, ${when(activity.startsAt)}. Fires at ${when(activity.opensAt)}.`);
        break;
      }

      case "jobs": {
        const userId = await resolveUser(db);
        const rows = await db
          .select({ job: registrationJobs, name: portalActivities.name, startsAt: portalActivities.startsAt })
          .from(registrationJobs)
          .innerJoin(portalActivities, eq(portalActivities.id, registrationJobs.portalActivityId))
          .where(eq(registrationJobs.userId, userId))
          .orderBy(desc(registrationJobs.opensAt))
          .limit(20);
        for (const { job, name, startsAt } of rows) {
          const detail = [job.errorCode, job.sendLatencyMs === null ? null : `sent T+${job.sendLatencyMs}ms`, job.postsSent ? `${job.postsSent} POST` : null].filter(Boolean).join(", ");
          console.log(`${job.id.slice(0, 8)}  ${job.state.padEnd(9)}  fires ${when(job.opensAt)}  ${name}, ${when(startsAt)}${detail ? `  (${detail})` : ""}`);
        }
        break;
      }

      case "cancel-job": {
        const prefix = values.job ?? fail("Pass --job <id or prefix>.");
        const matches = await db
          .select({ id: registrationJobs.id })
          .from(registrationJobs)
          .where(and(sql`${registrationJobs.id}::text like ${`${prefix}%`}`, inArray(registrationJobs.state, ["SCHEDULED", "ARMED"])));
        if (matches.length !== 1) fail(matches.length === 0 ? "No pending job matches." : "Several jobs match. Use a longer prefix.");
        // An armed job then fails the fire worker's FIRING check, so nothing is sent.
        await db.update(registrationJobs).set({ state: "CANCELLED", updatedAt: new Date() }).where(eq(registrationJobs.id, matches[0]!.id));
        console.log(`Job ${matches[0]!.id} cancelled.`);
        break;
      }

      case "telegram-link": {
        if (!services.linker) fail("Set TELEGRAM_BOT_TOKEN first.");
        const link = await services.linker!.createLink(await resolveUser(db));
        console.log(`Open this on your phone and press Start. It works once, for 30 minutes:\n${link}`);
        console.log("The session-worker must be running to receive it.");
        break;
      }

      default:
        fail(`Unknown command "${command}".\n\n${HELP}`);
    }
  } finally {
    await pool.end();
  }
}

await main();
