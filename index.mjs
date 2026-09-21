import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { isSea } from "node:sea";
import nodeHttp from "node:http";
import { chromium, request } from "playwright";

/**
 * ARCHITECTURE NOTE
 * ------------------
 * The old version had a single serial loop that slept (in <=1h chunks) until
 * the nearest triggerAt, then did discovery + login-check + token fetch + POST
 * all *after* waking up. That put avoidable work (headful browser discovery,
 * a blocking manual-login prompt, an extra GET round trip) on the critical
 * path, and a single long-lived process/timer chain had no way to recover
 * quickly if it was delayed (laptop sleep, crash, etc).
 *
 * This version splits each entry's lifecycle into three phases that run
 * independently and concurrently per entry:
 *
 *   1. DISCOVERY  - retried periodically starting a few minutes before
 *                   triggerAt (not just once), headless, so the activity id
 *                   is resolved as early as possible.
 *   2. WARM-UP    - a couple of seconds before triggerAt, fetch a fresh CSRF
 *                   token and keep the HTTP connection open, so nothing but
 *                   the POST itself happens at the actual trigger instant.
 *   3. FIRE       - wait to the trigger instant with fine-grained polling
 *                   (not a single long setTimeout) and submit immediately.
 *
 * On top of that:
 *   - Each pending entry gets its own independent async lifecycle instead of
 *     a single serial loop, so one slow/troubled entry can't delay another.
 *   - A heartbeat re-scans pending.json every HEARTBEAT_INTERVAL_MS and picks
 *     up anything overdue that isn't already being handled - this is the
 *     safety net if the process was restarted or a timer got delayed.
 *   - Session health is checked on its own schedule (SESSION_CHECK_INTERVAL_MS),
 *     completely decoupled from any specific trigger. If login is needed, it
 *     happens there - not as a blocking prompt in the middle of a fire.
 *   - At fire time, if the session turns out to be dead anyway, we do NOT
 *     block waiting for a human; we mark the entry "waiting-for-login" and
 *     move on, so a fire is never stuck for minutes on an unattended prompt.
 *
 * This process is meant to run persistently (under a supervisor like
 * systemd/pm2, ideally on an always-on host rather than a laptop that can
 * sleep) rather than run-to-completion.
 */

/**
 * Resolves the directory that activities.json / .state / etc should live
 * in. process.cwd() is NOT reliable for this: a double-clicked packaged
 * executable can start with almost any working directory depending on OS
 * and launch method. Instead:
 *   - Packaged as a pkg executable (process.pkg is injected by pkg) or a
 *     Node SEA binary (node:sea's isSea()): process.execPath IS the running
 *     executable, so its directory is "next to the executable".
 *   - Plain `node index.mjs`: resolve relative to this script file's own
 *     location (not cwd), so `cd elsewhere && node /path/to/index.mjs`
 *     still finds the right files.
 */
function getAppDir() {
  const isPkgBinary = typeof process.pkg !== "undefined";
  let isSeaBinary = false;
  try {
    isSeaBinary = isSea();
  } catch {
    isSeaBinary = false;
  }

  if (isPkgBinary || isSeaBinary) {
    return path.dirname(process.execPath);
  }
  return path.dirname(fileURLToPath(import.meta.url));
}

const APP_DIR = getAppDir();
const BASE_URL = "https://zdrofit.pl/#logowanie";
const STORAGE_DIR = path.join(APP_DIR, ".state");
const STORAGE_STATE_PATH = path.join(STORAGE_DIR, "auth.json");
const ACTIVITIES_PATH = path.join(APP_DIR, "activities.json");
const PENDING_PATH = path.join(STORAGE_DIR, "pending.json");
const ALERTS_LOG_PATH = path.join(STORAGE_DIR, "alerts.log");
const APP_LOG_PATH = path.join(STORAGE_DIR, "app.log");
const PUBLIC_DIR = path.join(APP_DIR, "public");
const DASHBOARD_HTML_PATH = path.join(PUBLIC_DIR, "dashboard.html");

const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36";

// ---- Tuning knobs -----------------------------------------------------
// How close to triggerAt to switch into tight discovery retries, after the
// single immediate attempt (made when the entry is first scheduled) fails.
const DISCOVERY_LEAD_MS = 5 * 60 * 1000;
// How often to retry discovery once inside the tight window above.
const DISCOVERY_POLL_MS = 15 * 1000;
// How long before triggerAt to fetch a fresh token / warm the connection.
const WARMUP_LEAD_MS = 2000;
// How often to re-verify the session, independent of any trigger.
const SESSION_CHECK_INTERVAL_MS = 15 * 60 * 1000;
// How often to re-scan pending.json for newly-added or missed entries.
const HEARTBEAT_INTERVAL_MS = 15 * 1000;
// Resolution of the final busy-poll right before firing.
const FINE_POLL_MS = 25;
// Switch to fine-grained polling once within this many ms of the target.
const FINE_POLL_THRESHOLD_MS = 1500;
// app.log gets trimmed to the last APP_LOG_KEEP_LINES once it passes this size.
const APP_LOG_MAX_BYTES = 5 * 1024 * 1024;
const APP_LOG_KEEP_LINES = 5000;
const APP_LOG_TRIM_INTERVAL_MS = 30 * 60 * 1000;

function now() {
  return new Date().toISOString();
}

/**
 * Console output alone is invisible once the dashboard replaces the
 * terminal as the primary way of watching this thing - so every log line
 * also gets appended to app.log, which GET /api/logs tails for the
 * dashboard's "Logs" tab. Fire-and-forget: a logging failure should never
 * take down the scheduler.
 */
function log(msg) {
  const line = `[${now()}] ${msg}`;
  console.log(line);
  fs.appendFile(APP_LOG_PATH, line + "\n", "utf8").catch(() => {
    /* best effort only */
  });
}

/** Keeps app.log from growing forever across a long-lived process. */
async function trimLogFileIfLarge() {
  try {
    const stat = await fs.stat(APP_LOG_PATH);
    if (stat.size <= APP_LOG_MAX_BYTES) return;
    const raw = await fs.readFile(APP_LOG_PATH, "utf8");
    const lines = raw.split("\n").filter(Boolean);
    const trimmed = lines.slice(-APP_LOG_KEEP_LINES).join("\n") + "\n";
    await fs.writeFile(APP_LOG_PATH, trimmed, "utf8");
    log(`Trimmed app.log to the last ${APP_LOG_KEEP_LINES} lines.`);
  } catch {
    /* file may not exist yet, or a transient FS error - not worth crashing over */
  }
}

function sleep(ms) {
  return new Promise((res) => setTimeout(res, Math.max(ms, 0)));
}

/**
 * A console log() line is easy to miss on an unattended machine. This adds
 * two more channels: a persistent alert log file you can `tail -f`, and a
 * best-effort native OS notification (macOS/Linux) - both fail silently if
 * unavailable, so this can never crash the scheduler.
 */
function notifyLoud(title, message) {
  const banner = "!".repeat(60);
  console.log(`\u0007\n${banner}\n[ALERT] ${title}: ${message}\n${banner}\n`);

  fs.mkdir(STORAGE_DIR, { recursive: true })
    .then(() => fs.appendFile(ALERTS_LOG_PATH, `[${now()}] ${title}: ${message}\n`, "utf8"))
    .catch(() => {
      /* best effort only */
    });

  try {
    if (process.platform === "darwin") {
      execFile(
        "osascript",
        ["-e", `display notification ${JSON.stringify(message)} with title ${JSON.stringify(title)} sound name "Basso"`],
        () => {}
      );
    } else if (process.platform === "linux") {
      execFile("notify-send", ["-u", "critical", title, message], () => {});
    }
  } catch {
    /* best effort only - console + alert log above are the guaranteed channels */
  }
}

/**
 * Logs each stored cookie's expiry so you can watch, over successive
 * sessionWatchdog cycles, whether it moves forward (sliding/idle-timeout
 * expiration, extended by activity) or stays fixed (absolute expiration,
 * where only a fresh manual login will extend it).
 */
function logCookieExpiries(storageState) {
  const cookies = (storageState && storageState.cookies) || [];
  if (cookies.length === 0) {
    log("Session cookie inspection: no cookies found in storage state.");
    return;
  }
  const summary = cookies
    .map((c) => {
      const exp = c.expires && c.expires > 0 ? new Date(c.expires * 1000).toISOString() : "session-only (no fixed expiry)";
      return `${c.name}=${exp}`;
    })
    .join(", ");
  log(`Session cookies: ${summary}`);
}

/**
 * Persists the http client's *current* cookie jar to disk and logs it. This
 * matters because createHttpClient() only loads storageState from disk once;
 * if the server extends a cookie's lifetime via Set-Cookie on an ordinary
 * request, that update lives only in memory until we explicitly re-save it
 * here - so without this, the on-disk expiry would look "fixed" even if the
 * real session is actually sliding.
 */
async function persistAndLogSession(http) {
  try {
    const state = await http.storageState({ path: STORAGE_STATE_PATH });
    logCookieExpiries(state);
  } catch (err) {
    log(`Could not persist/inspect session state: ${err}`);
  }
}

/**
 * Sleeps until targetMs (epoch ms), using coarse chunked sleeps for the bulk
 * of the wait (cheap, fine for long waits) and then a fine-grained busy-poll
 * for the last ~1.5s so the actual fire time tracks the target far more
 * tightly than a single long timer would under any scheduling jitter.
 */
async function waitUntilPrecise(targetMs) {
  let remaining = targetMs - Date.now();
  while (remaining > FINE_POLL_THRESHOLD_MS) {
    const chunk = Math.min(remaining - 1000, 60 * 60 * 1000);
    await sleep(chunk);
    remaining = targetMs - Date.now();
  }
  while (Date.now() < targetMs) {
    await sleep(FINE_POLL_MS);
  }
}

function parseTargetDatetime(targetDatetime) {
  // expect 'YYYY-MM-DD HH:MM'
  if (!targetDatetime) return null;
  const [date, time] = targetDatetime.split(" ");
  if (!date || !time) return null;
  const iso = `${date}T${time}:00`;
  const d = new Date(iso);
  return isNaN(d.getTime()) ? null : d;
}

async function fileExists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function ensureStateDir() {
  await fs.mkdir(STORAGE_DIR, { recursive: true });
}

// ---- Pending queue storage, with serialized writes ---------------------
// Multiple entry lifecycles run concurrently and may want to update
// pending.json at the same time; writeChain serializes read-modify-write
// cycles so concurrent updates don't clobber each other.

async function loadPendingQueue() {
  try {
    const raw = await fs.readFile(PENDING_PATH, "utf8");
    return JSON.parse(raw);
  } catch {
    return [];
  }
}

async function savePendingQueue(queue) {
  await fs.writeFile(PENDING_PATH, JSON.stringify(queue, null, 2), "utf8");
}

function entryKey(e) {
  return `${e.link}||${e.clubSlug}||${e.targetDatetime}`;
}

let writeChain = Promise.resolve();

/** Serializes a read-modify-write cycle against pending.json. */
function withPendingQueue(mutator) {
  writeChain = writeChain
    .then(async () => {
      const queue = await loadPendingQueue();
      await mutator(queue);
      await savePendingQueue(queue);
    })
    .catch((err) => {
      log(`Pending queue update failed: ${err}`);
    });
  return writeChain;
}

/** Patches the persisted entry matching `entry`'s key, and mirrors the patch onto `entry` itself. */
function updateEntry(entry, patch) {
  Object.assign(entry, patch);
  return withPendingQueue((queue) => {
    const idx = queue.findIndex((x) => entryKey(x) === entryKey(entry));
    if (idx !== -1) Object.assign(queue[idx], patch);
  });
}

async function buildPendingQueueIfMissing(activities) {
  await ensureStateDir();
  const existing = await loadPendingQueue();
  if (existing && existing.length > 0) return existing;

  const queue = [];
  const createdAt = new Date().toISOString();
  for (const a of activities) {
    const td = parseTargetDatetime(a.targetDatetime);
    if (!td) continue;
    const triggerAt = new Date(td.getTime() - 48 * 60 * 60 * 1000).toISOString();
    queue.push({
      id: a.id || "",
      clubSlug: a.clubSlug || extractClubSlugFromLink(a.link),
      link: a.link || "",
      keyword: a.keyword || "",
      targetDatetime: a.targetDatetime,
      triggerAt,
      status: "pending",
      attempts: 0,
      createdAt,
    });
  }
  await savePendingQueue(queue);
  return queue;
}

/**
 * Brings pending.json in line with an edited activities.json (as expanded
 * by readActivities()): adds a fresh "pending" row for any date/time that's
 * new, and marks any existing "pending" row "cancelled" if its date/time
 * was removed from activities.json. Rows already "done"/"failed"/etc are
 * left untouched - this only ever touches still-pending entries, so history
 * from before the edit isn't lost. Used by the dashboard's save-activities
 * route (buildPendingQueueIfMissing only ever runs once, on first launch).
 */
async function reconcilePendingQueueWithActivities(expandedActivities) {
  const createdAt = new Date().toISOString();
  const desiredKeys = new Set();
  const candidates = [];

  for (const a of expandedActivities) {
    const td = parseTargetDatetime(a.targetDatetime);
    if (!td) continue;
    const triggerAt = new Date(td.getTime() - 48 * 60 * 60 * 1000).toISOString();
    const candidate = {
      id: a.id || "",
      clubSlug: a.clubSlug || extractClubSlugFromLink(a.link),
      link: a.link || "",
      keyword: a.keyword || "",
      targetDatetime: a.targetDatetime,
      triggerAt,
    };
    desiredKeys.add(entryKey(candidate));
    candidates.push(candidate);
  }

  let added = 0;
  let cancelled = 0;

  await withPendingQueue((queue) => {
    const existingKeys = new Set(queue.map((x) => entryKey(x)));

    for (const candidate of candidates) {
      if (existingKeys.has(entryKey(candidate))) continue;
      queue.push({ ...candidate, status: "pending", attempts: 0, createdAt });
      added++;
    }

    for (const x of queue) {
      if (x.status === "pending" && !desiredKeys.has(entryKey(x))) {
        x.status = "cancelled";
        x.cancelledAt = createdAt;
        cancelledEntryKeys.add(entryKey(x));
        cancelled++;
      }
    }
  });

  return { added, cancelled };
}

async function readActivities() {
  const exists = await fileExists(ACTIVITIES_PATH);
  if (!exists) {
    throw new Error(
      "Missing activities.json. Start the app and add your first activity from the dashboard, or create the file yourself."
    );
  }

  const raw = await fs.readFile(ACTIVITIES_PATH, "utf8");
  const data = JSON.parse(raw);

  if (!Array.isArray(data) || data.length === 0) {
    throw new Error("activities.json must contain a non-empty array.");
  }

  // Support two schemas:
  // 1) legacy: { id, clubSlug }
  // 2) new: { link, keyword, dates: { 'YYYY-MM-DD': ['HH:MM'] }, clubSlug?, id? }
  const expanded = [];
  for (const raw of data.filter((item) => item && item.enabled !== false)) {
    const item = raw;
    if (item.dates && typeof item.dates === "object") {
      if (!item.link && !item.clubSlug) {
        throw new Error("activities.json entry with dates must include 'link' or 'clubSlug'");
      }
      for (const date of Object.keys(item.dates)) {
        const times = Array.isArray(item.dates[date]) ? item.dates[date] : [];
        for (const time of times) {
          const targetDatetime = `${date} ${time}`;
          expanded.push({
            id: item.id ? String(item.id).trim() : "",
            clubSlug: String(item.clubSlug || "").trim(),
            link: String(item.link || "").trim(),
            keyword: String(item.keyword || "").trim(),
            targetDatetime,
            rawItem: item,
          });
        }
      }
      continue;
    }

    if (item.id) {
      expanded.push({
        id: String(item.id).trim(),
        clubSlug: String(item.clubSlug || "").trim(),
        link: String(item.link || "").trim(),
        keyword: String(item.keyword || "").trim(),
        targetDatetime: item.targetDatetime || "",
        rawItem: item,
      });
      continue;
    }

    throw new Error("Unsupported activities.json entry: must include 'id' or 'dates' mapping.");
  }

  if (expanded.length === 0) {
    throw new Error("No enabled activities in activities.json.");
  }

  return expanded;
}

function extractClubSlugFromLink(link) {
  if (!link) return "";
  const m = link.match(/kluby-fitness\/([a-z0-9-]+)/i);
  return m ? m[1].toLowerCase() : "";
}

// ---- HTML / response parsing --------------------------------------------

function isAuthenticatedHtml(html) {
  return html.includes("Wyloguj się") || html.includes("/logout");
}

function isLoginHtml(html) {
  return (
    html.includes("member_login_form") ||
    html.includes("member_login_form[_token]") ||
    html.includes("g-recaptcha-response")
  );
}

function parseToken(html) {
  const m = html.match(/name="schedule_register_form\[_token\]"\s+value="([^"]+)"/);
  return m ? m[1] : null;
}

function parseAlreadyRegistered(html, activityId) {
  const pattern = new RegExp(`id=\"schedule-item-${activityId}\"[\\s\\S]*?item-member-registered`, "i");
  return pattern.test(html) || html.includes("Zapisano");
}

function isEnrollSuccess(html, activityId) {
  return parseAlreadyRegistered(html, activityId);
}

function detectUnauthorized(responseUrl, status, html) {
  if (status === 401 || status === 403) return true;
  if (responseUrl.includes("/login")) return true;
  if (isLoginHtml(html) && !isAuthenticatedHtml(html)) return true;
  return false;
}

// ---- HTTP client / session management -----------------------------------

async function createHttpClient() {
  const hasState = await fileExists(STORAGE_STATE_PATH);
  return request.newContext({
    baseURL: BASE_URL,
    userAgent: USER_AGENT,
    storageState: hasState ? STORAGE_STATE_PATH : undefined,
    extraHTTPHeaders: {
      Accept: "*/*",
      "Accept-Language": "pl-PL,pl;q=0.9,en-US;q=0.8,en;q=0.7",
      Origin: BASE_URL,
    },
  });
}

async function verifyExistingSession(http) {
  const response = await http.get("/zajecia");
  const body = await response.text();
  return !detectUnauthorized(response.url(), response.status(), body);
}

async function manualLogin() {
  await ensureStateDir();

  log("Opening browser for manual login. Complete login and captcha there.");
  const browser = await chromium.launch({ headless: false });
  const context = await browser.newContext({
    userAgent: USER_AGENT,
    viewport: { width: 1280, height: 900 },
  });
  const page = await context.newPage();
  await page.goto(`${BASE_URL}/`, { waitUntil: "domcontentloaded" });

  log("After successful login in the browser, return here and press Enter.");
  const rl = readline.createInterface({ input, output });
  await rl.question("Press Enter when logged in... ");
  rl.close();

  const state = await context.storageState({ path: STORAGE_STATE_PATH });
  await browser.close();
  log(`Saved browser session state to ${STORAGE_STATE_PATH}`);
  logCookieExpiries(state);
}

/**
 * Blocking, headful login check+recover. Only used by the session watchdog,
 * which runs on its own independent schedule - never inline in a fire path.
 */
async function ensureLoggedIn(http) {
  const sessionOk = await verifyExistingSession(http);
  if (sessionOk) return http;

  log("Session missing or expired. Starting manual re-login fallback.");
  notifyLoud("zdrofit session expired", "Session invalid - opening a browser window for manual re-login now.");
  await http.dispose();
  await manualLogin();

  const refreshed = await createHttpClient();
  const okAfterLogin = await verifyExistingSession(refreshed);
  if (!okAfterLogin) {
    await refreshed.dispose();
    throw new Error("Manual login did not produce a valid authenticated session.");
  }

  log("Manual re-login successful. Resuming unattended flow.");
  return refreshed;
}

// ---- Playwright-based activity id discovery ------------------------------

async function gatherActivityIdWithPlaywright(activity, options = {}) {
  await ensureStateDir();
  const debug = { activity, found: null, candidates: [] };

  const hasState = await fileExists(STORAGE_STATE_PATH);
  const headless = options.headless !== undefined ? options.headless : true;
  const browser = await chromium.launch({ headless });
  const context = await browser.newContext({
    userAgent: USER_AGENT,
    viewport: { width: 1280, height: 900 },
    storageState: hasState ? STORAGE_STATE_PATH : undefined,
  });

  const page = await context.newPage();
  const url = activity.link || `${BASE_URL}/kluby-fitness/${activity.clubSlug}/grafik-zajec#`;
  await page.goto(url, { waitUntil: "domcontentloaded" });

  const content = await page.content();
  if (isLoginHtml(content) && !isAuthenticatedHtml(content)) {
    await browser.close();
    // Discovery should never block on a headful login itself; surface the
    // need for login and let the session watchdog handle it on its own
    // schedule instead of recursing into a blocking prompt here.
    return { id: null, reason: "Session not authenticated; waiting for session watchdog to re-login." };
  }

  const date = activity.targetDatetime ? activity.targetDatetime.split(" ")[0] : null;
  if (!date) {
    await browser.close();
    return { id: null, reason: "Missing date in activity.targetDatetime" };
  }

  try {
    await page.waitForSelector("div.schedule-days", { timeout: 5000 });
    const btn = await page.$(`div.schedule-days button[value=\"${date}\"]`);
    if (btn) {
      await btn.click();
      await page.waitForTimeout(500);
    }

    await page.waitForSelector("#schedule-rano, #schedule-po-poludniu", { timeout: 5000 });

    const candidates = await page.$$eval(
      "#schedule-rano ul li[data-id][data-activity], #schedule-po-poludniu ul li[data-id][data-activity]",
      (nodes) =>
        nodes.map((n) => {
          const timeEl = n.querySelector("time[datetime]");
          return {
            id: n.getAttribute("data-id"),
            activity: n.getAttribute("data-activity"),
            datetime: timeEl ? timeEl.getAttribute("datetime") : null,
            outer: n.outerHTML.slice(0, 200),
          };
        })
    );

    debug.candidates = candidates;

    const target = activity.targetDatetime.replace(/\s+/g, " ").trim();
    const keyword = (activity.keyword || "").toLowerCase();

    for (const c of candidates) {
      if (!c.datetime) continue;
      const norm = c.datetime.replace(/\s+/g, " ").trim();
      const act = (c.activity || "").toLowerCase();
      if (norm === target && (keyword === "" || act.includes(keyword))) {
        debug.found = c;
        await fs.writeFile(path.join(STORAGE_DIR, "last-gather.json"), JSON.stringify(debug, null, 2), "utf8");
        await context.storageState({ path: STORAGE_STATE_PATH });
        await browser.close();
        return { id: String(c.id) };
      }
    }

    await fs.writeFile(path.join(STORAGE_DIR, "last-gather.json"), JSON.stringify(debug, null, 2), "utf8");
    await context.storageState({ path: STORAGE_STATE_PATH });
    await browser.close();
    return { id: null, reason: "No matching li found", debugFile: path.join(STORAGE_DIR, "last-gather.json") };
  } catch (err) {
    await fs.writeFile(
      path.join(STORAGE_DIR, "last-gather.json"),
      JSON.stringify({ error: String(err), debug }, null, 2),
      "utf8"
    );
    await browser.close();
    return { id: null, reason: `Playwright error: ${err.message}`, debugFile: path.join(STORAGE_DIR, "last-gather.json") };
  }
}

// ---- Registration HTTP calls --------------------------------------------

async function fetchRegistrationPage(http, activity) {
  const pathPart = `/kluby-fitness/${activity.clubSlug}/grafik-zajec/${activity.id}`;
  const response = await http.get(pathPart);
  const html = await response.text();
  return { pathPart, status: response.status(), url: response.url(), html };
}

async function submitEnrollment(http, activity, token) {
  const response = await http.post(`/grafik-zajec/${activity.id}`, {
    form: {
      "schedule_register_form[id]": activity.id,
      "schedule_register_form[_redirect]": "",
      "schedule_register_form[_token]": token,
    },
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Referer: `${BASE_URL}/kluby-fitness/${activity.clubSlug}/grafik-zajec/${activity.id}`,
    },
  });

  const html = await response.text();
  return { status: response.status(), url: response.url(), html };
}

// ---- Per-entry lifecycle: discover -> warm up -> fire --------------------

/**
 * Checks whether this entry has been cancelled since its lifecycle started
 * - e.g. the dashboard's reconciliation marked it "cancelled" because it
 * was removed from activities.json. A running lifecycle doesn't otherwise
 * notice an external edit like that, so long-lived phases (discovery's
 * retry loop, and the fire step itself) check this explicitly.
 *
 * Backed by an in-memory Set (cancelledEntryKeys, populated directly by
 * reconcilePendingQueueWithActivities below) rather than a disk read -
 * scheduler and dashboard both run in this one process, so there's no need
 * to round-trip through pending.json to learn about a cancellation, and
 * doing so put an unpredictable-latency disk read right on the critical
 * path between waking up and actually firing.
 */
function isEntryCancelled(entry) {
  return cancelledEntryKeys.has(entryKey(entry));
}

/**
 * Tries discovery once right away (in case the schedule is already visible
 * well ahead of the registration-open point - cheap to check, and means a
 * restart close to trigger, or a site that lists further out than assumed,
 * gets picked up immediately). If that fails, it does NOT keep polling for
 * however many hours/days remain (that would mean hundreds of headless
 * browser launches per entry) - instead it waits for the tight window
 * within DISCOVERY_LEAD_MS of the trigger and retries every
 * DISCOVERY_POLL_MS there, which also fixes the old one-shot-then-give-up
 * behavior for the common case where the slot only appears near trigger.
 */
async function discoveryLoop(entry, triggerTime) {
  if (!entry.id) {
    await attemptDiscovery(entry);
  }
  if (entry.id) return;

  const leadStart = triggerTime - DISCOVERY_LEAD_MS;
  if (Date.now() < leadStart) {
    await waitUntilPrecise(leadStart);
  }
  while (!entry.id && Date.now() < triggerTime) {
    if (isEntryCancelled(entry)) {
      log(`Stopping discovery for ${entry.targetDatetime}: entry was cancelled.`);
      return;
    }
    await attemptDiscovery(entry);
    if (entry.id) return;
    await sleep(DISCOVERY_POLL_MS);
  }
}

async function attemptDiscovery(entry) {
  const res = await gatherActivityIdWithPlaywright(entry, { headless: true });
  if (res && res.id) {
    await updateEntry(entry, { id: res.id });
    log(`Discovered id ${res.id} for ${entry.targetDatetime}.`);
  }
  return res;
}

/**
 * Fetches a fresh token and leaves the HTTP connection open, a couple of
 * seconds before the trigger, so the fire step is just a single POST.
 * Returns null (and disposes any client it opened) if anything's not ready;
 * fireEntry() falls back to doing the same work fresh in that case.
 */
async function tryWarmup(entry) {
  let http;
  try {
    http = await createHttpClient();
    const sessionOk = await verifyExistingSession(http);
    if (!sessionOk) {
      await http.dispose();
      return null;
    }
    const page = await fetchRegistrationPage(http, entry);
    if (detectUnauthorized(page.url, page.status, page.html)) {
      await http.dispose();
      return null;
    }
    const token = parseToken(page.html);
    if (!token) {
      await http.dispose();
      return null;
    }
    return { http, warmToken: token };
  } catch (err) {
    log(`Warm-up failed for ${entry.targetDatetime}: ${err}`);
    if (http) {
      try {
        await http.dispose();
      } catch {
        /* ignore */
      }
    }
    return null;
  }
}

/**
 * This is the time-critical case: a real trigger just fired and couldn't go
 * through because of session state. Unlike the routine watchdog check, this
 * means a class slot may be filling up right now, so it's worth a loud
 * alert every time - not just once.
 */
function alertSessionBlockedFire(entry, reason) {
  notifyLoud(
    "zdrofit registration blocked",
    `${entry.targetDatetime} (${entry.keyword || entry.clubSlug}): ${reason}`
  );
}

/**
 * The only thing that should happen exactly at triggerAt: submit using a
 * pre-warmed client/token when available, otherwise do it fresh. Never
 * blocks on a headful manual login - if the session is dead here, mark
 * waiting-for-login and move on so a fire is never stuck.
 */
async function fireEntry(entry, warm = {}) {
  // Captured before the cancellation check below (which is now an in-memory
  // Set lookup, not a disk read - see isEntryCancelled's comment) so this
  // purely reflects waitUntilPrecise's wake accuracy, not anything after it.
  const firedAt = Date.now();
  const targetMs = new Date(entry.triggerAt).getTime();
  const latencyMs = firedAt - targetMs;
  const elapsedSinceTrigger = () => Date.now() - targetMs;

  if (isEntryCancelled(entry)) {
    log(`Skipping fire for ${entry.targetDatetime}: entry was cancelled before trigger.`);
    if (warm.http) {
      try {
        await warm.http.dispose();
      } catch {
        /* ignore */
      }
    }
    return;
  }

  log(
    `Firing enrollment for ${entry.targetDatetime} (id=${entry.id || "(unknown)"}), ${latencyMs}ms after trigger, ` +
      `${warm.http ? "using a pre-warmed connection" : "using a fresh connection (no warm-up)"}.`
  );

  let http = warm.http;
  let token = warm.warmToken || null;

  if (!http) {
    http = await createHttpClient();
    const sessionOk = await verifyExistingSession(http);
    if (!sessionOk) {
      log(`Session invalid at fire time for ${entry.targetDatetime}; not blocking, marking waiting-for-login.`);
      alertSessionBlockedFire(entry, "session was invalid at fire time");
      await updateEntry(entry, { status: "waiting-for-login", latencyMs, completedLatencyMs: elapsedSinceTrigger() });
      await http.dispose();
      return;
    }
  }

  if (!entry.id) {
    const discoveryStarted = Date.now();
    const res = await gatherActivityIdWithPlaywright(entry, { headless: true });
    log(`Discovery at fire time for ${entry.targetDatetime} took ${Date.now() - discoveryStarted}ms.`);
    if (res && res.id) {
      await updateEntry(entry, { id: res.id });
    } else {
      log(`Discovery failed at fire time for ${entry.targetDatetime}: ${res && res.reason}`);
      await updateEntry(entry, { status: "failed-discovery", latencyMs, completedLatencyMs: elapsedSinceTrigger() });
      await http.dispose();
      return;
    }
  }

  if (!token) {
    const page = await fetchRegistrationPage(http, entry);
    if (detectUnauthorized(page.url, page.status, page.html)) {
      log(`Unauthorized fetching registration page at fire time for ${entry.targetDatetime}.`);
      alertSessionBlockedFire(entry, "session was rejected while fetching the registration page");
      await updateEntry(entry, { status: "waiting-for-login", latencyMs, completedLatencyMs: elapsedSinceTrigger() });
      await http.dispose();
      return;
    }
    token = parseToken(page.html);
  }

  if (!token) {
    await updateEntry(entry, {
      status: "failed-token",
      attempts: (entry.attempts || 0) + 1,
      latencyMs,
      completedLatencyMs: elapsedSinceTrigger(),
    });
    await http.dispose();
    return;
  }

  let resp = await submitEnrollment(http, entry, token);

  if (detectUnauthorized(resp.url, resp.status, resp.html)) {
    log(`Unauthorized during submit for ${entry.targetDatetime}.`);
    alertSessionBlockedFire(entry, "session was rejected while submitting the registration");
    await updateEntry(entry, { status: "waiting-for-login", latencyMs, completedLatencyMs: elapsedSinceTrigger() });
    await http.dispose();
    return;
  }

  if (!isEnrollSuccess(resp.html, entry.id)) {
    // One retry with a freshly fetched token, in case the warm/original one
    // was stale or single-use. This doubles the remaining network round
    // trips, so it's logged explicitly - it's a plausible source of extra
    // latency in its own right, especially if the server is slow right at
    // the trigger moment because everyone else is hitting it too.
    log(`First submission for ${entry.targetDatetime} didn't look like success - retrying with a fresh token.`);
    const page2 = await fetchRegistrationPage(http, entry);
    const token2 = parseToken(page2.html);
    if (token2) {
      resp = await submitEnrollment(http, entry, token2);
    }
  }

  const completedLatencyMs = elapsedSinceTrigger();

  if (isEnrollSuccess(resp.html, entry.id)) {
    await updateEntry(entry, { status: "done", doneAt: new Date().toISOString(), latencyMs, completedLatencyMs });
    log(`Registered for ${entry.targetDatetime}: woke ${latencyMs}ms after trigger, confirmed ${completedLatencyMs}ms after trigger.`);
  } else {
    await updateEntry(entry, {
      status: "failed",
      resultSnippet: resp.html.slice(0, 500).replace(/\s+/g, " "),
      latencyMs,
      completedLatencyMs,
    });
    log(`Failed to register for ${entry.targetDatetime}: woke ${latencyMs}ms after trigger, gave up ${completedLatencyMs}ms after trigger.`);
  }

  await http.dispose();
}

async function runEntryLifecycle(entry) {
  const triggerTime = new Date(entry.triggerAt).getTime();

  if (!entry.id) {
    await discoveryLoop(entry, triggerTime);
  }

  let warm = null;
  if (entry.id && Date.now() < triggerTime) {
    await waitUntilPrecise(triggerTime - WARMUP_LEAD_MS);
    if (Date.now() < triggerTime) {
      warm = await tryWarmup(entry);
    }
  }

  await waitUntilPrecise(triggerTime);
  await fireEntry(entry, warm || {});
}

// ---- Scheduler: independent per-entry timers + catch-up heartbeat -------

const scheduled = new Set();
// Populated by reconcilePendingQueueWithActivities when a pending entry gets
// cancelled; read synchronously by isEntryCancelled(). Small and bounded in
// practice (one key per cancellation over the process's lifetime, at this
// tool's scale) so it's never worth cleaning up.
const cancelledEntryKeys = new Set();

function scheduleEntry(entry) {
  const key = entryKey(entry);
  if (scheduled.has(key)) return;
  scheduled.add(key);
  runEntryLifecycle(entry)
    .catch((err) => log(`Lifecycle error for ${entry.targetDatetime}: ${err}`))
    .finally(() => scheduled.delete(key));
}

async function scanAndSchedule() {
  const queue = await loadPendingQueue();
  for (const entry of queue) {
    if (entry.status !== "pending") continue;
    scheduleEntry(entry);
  }
}

/**
 * Verifies the session on its own independent cadence, decoupled from any
 * specific trigger, so a blocking headful re-login (when actually needed)
 * happens with plenty of slack instead of racing a fire.
 */
async function sessionWatchdog() {
  while (true) {
    try {
      let http = await createHttpClient();
      http = await ensureLoggedIn(http); // blocking re-login lives here, on its own schedule - never in a fire path
      await persistAndLogSession(http); // re-saves the (possibly server-extended) cookie jar and logs its expiry
      await http.dispose();
    } catch (err) {
      log(`Session watchdog error: ${err}`);
      notifyLoud("zdrofit session watchdog error", String(err));
    }
    await sleep(SESSION_CHECK_INTERVAL_MS);
  }
}

// ---- Local dashboard: HTTP server, JSON API, static HTML ----------------
// Runs in this same process (see chat) so it shares the scheduler's file
// access directly - no separate service, no IPC. Bound to 127.0.0.1 only:
// this is a single-user local tool, so there's no LAN exposure and no need
// for auth.

function readJsonBody(req, maxBytes = 2_000_000) {
  return new Promise((resolve, reject) => {
    let data = "";
    let bytes = 0;
    req.on("data", (chunk) => {
      bytes += chunk.length;
      if (bytes > maxBytes) {
        reject(new Error("Request body too large"));
        req.destroy();
        return;
      }
      data += chunk;
    });
    req.on("end", () => {
      if (!data) return resolve(null);
      try {
        resolve(JSON.parse(data));
      } catch {
        reject(new Error("Invalid JSON body"));
      }
    });
    req.on("error", reject);
  });
}

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
  });
  res.end(body);
}

const DASHBOARD_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const DASHBOARD_TIME_RE = /^\d{2}:\d{2}$/;

/**
 * Validates the shape the dashboard's activities editor submits (the same
 * "dates" schema activities.json already uses) before it's ever written to
 * disk. Returns a list of human-readable problems; empty means valid.
 */
function validateActivitiesPayload(payload) {
  if (!Array.isArray(payload)) {
    return ["Payload must be an array of activities."];
  }

  const errors = [];
  payload.forEach((item, idx) => {
    const label = `Club ${idx + 1}`;
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      errors.push(`${label}: must be an object.`);
      return;
    }
    if (!String(item.link || "").trim() && !String(item.clubSlug || "").trim()) {
      errors.push(`${label}: needs a link or a club slug.`);
    }
    if (!item.dates || typeof item.dates !== "object" || Array.isArray(item.dates)) {
      errors.push(`${label}: needs at least one date with a time.`);
      return;
    }
    for (const [date, times] of Object.entries(item.dates)) {
      if (!DASHBOARD_DATE_RE.test(date)) {
        errors.push(`${label}: "${date}" isn't a valid date (expected YYYY-MM-DD).`);
      }
      if (!Array.isArray(times) || times.length === 0) {
        errors.push(`${label}: ${date} needs at least one time.`);
        continue;
      }
      for (const t of times) {
        if (!DASHBOARD_TIME_RE.test(t)) {
          errors.push(`${label}: "${t}" on ${date} isn't a valid time (expected HH:MM).`);
        }
      }
    }
  });
  return errors;
}

async function handleGetActivities(req, res) {
  const exists = await fileExists(ACTIVITIES_PATH);
  if (!exists) return sendJson(res, 200, []);
  try {
    const raw = await fs.readFile(ACTIVITIES_PATH, "utf8");
    sendJson(res, 200, JSON.parse(raw));
  } catch (err) {
    sendJson(res, 500, { error: `Could not read activities.json: ${err.message}` });
  }
}

async function handleSaveActivities(req, res) {
  let payload;
  try {
    payload = await readJsonBody(req);
  } catch (err) {
    return sendJson(res, 400, { error: err.message });
  }

  const errors = validateActivitiesPayload(payload);
  if (errors.length > 0) {
    return sendJson(res, 400, { error: "Validation failed", details: errors });
  }

  await ensureStateDir();
  await fs.writeFile(ACTIVITIES_PATH, JSON.stringify(payload, null, 2), "utf8");

  let expanded;
  try {
    expanded = await readActivities();
  } catch (err) {
    return sendJson(res, 500, { error: `Saved, but couldn't re-read activities.json: ${err.message}` });
  }

  const { added, cancelled } = await reconcilePendingQueueWithActivities(expanded);
  await scanAndSchedule(); // pick up newly-added entries immediately, don't wait for the heartbeat

  log(`activities.json updated via dashboard: ${added} added, ${cancelled} cancelled.`);
  sendJson(res, 200, { ok: true, added, cancelled });
}

async function handleGetStatus(req, res) {
  const queue = await loadPendingQueue();
  const entries = [...queue].sort((a, b) => new Date(a.triggerAt) - new Date(b.triggerAt));
  const counts = {};
  for (const e of entries) counts[e.status] = (counts[e.status] || 0) + 1;
  sendJson(res, 200, { entries, counts });
}

async function tailFile(filePath, maxLines) {
  try {
    const raw = await fs.readFile(filePath, "utf8");
    const lines = raw.split("\n").filter(Boolean);
    return lines.slice(-maxLines);
  } catch {
    return [];
  }
}

async function handleGetLogs(req, res, query) {
  const requested = parseInt(query.get("tail") || "200", 10);
  const tail = Math.min(Math.max(Number.isFinite(requested) ? requested : 200, 1), 2000);
  const [logLines, alertLines] = await Promise.all([tailFile(APP_LOG_PATH, tail), tailFile(ALERTS_LOG_PATH, tail)]);
  sendJson(res, 200, { log: logLines, alerts: alertLines });
}

async function serveDashboardHtml(res) {
  try {
    const html = await fs.readFile(DASHBOARD_HTML_PATH, "utf8");
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(html);
  } catch (err) {
    res.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" });
    res.end(
      `Could not load the dashboard page from ${DASHBOARD_HTML_PATH}: ${err.message}\n` +
        "Make sure the 'public' folder shipped alongside index.mjs."
    );
  }
}

async function servePublicFile(res, relativePath) {
  const resolvedPath = path.join(PUBLIC_DIR, relativePath);
  try {
    const file = await fs.readFile(resolvedPath);
    const ext = path.extname(relativePath).toLowerCase();
    const mimeTypes = {
      ".html": "text/html; charset=utf-8",
      ".css": "text/css; charset=utf-8",
      ".js": "application/javascript; charset=utf-8",
      ".json": "application/json; charset=utf-8",
      ".png": "image/png",
      ".jpg": "image/jpeg",
      ".jpeg": "image/jpeg",
      ".svg": "image/svg+xml",
      ".ico": "image/x-icon",
      ".webp": "image/webp",
    };
    res.writeHead(200, { "Content-Type": mimeTypes[ext] || "application/octet-stream" });
    res.end(file);
  } catch {
    notFound(res);
  }
}

function notFound(res) {
  res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
  res.end("Not found");
}

async function dashboardRequestHandler(req, res) {
  try {
    const url = new URL(req.url, "http://localhost");
    const { pathname } = url;

    if (req.method === "GET" && (pathname === "/" || pathname === "/index.html")) {
      return await serveDashboardHtml(res);
    }
    if (req.method === "GET" && pathname === "/favicon.ico") {
      return await servePublicFile(res, "favicon.ico");
    }
    if (req.method === "GET" && pathname === "/api/activities") {
      return await handleGetActivities(req, res);
    }
    if (req.method === "POST" && pathname === "/api/activities") {
      return await handleSaveActivities(req, res);
    }
    if (req.method === "GET" && pathname === "/api/status") {
      return await handleGetStatus(req, res);
    }
    if (req.method === "GET" && pathname === "/api/logs") {
      return await handleGetLogs(req, res, url.searchParams);
    }
    return notFound(res);
  } catch (err) {
    log(`Dashboard request error: ${err}`);
    sendJson(res, 500, { error: String(err) });
  }
}

/** Best-effort only - if this fails, the log line with the URL is the fallback. */
function openInBrowser(url) {
  try {
    if (process.platform === "darwin") {
      execFile("open", [url], () => {});
    } else if (process.platform === "win32") {
      execFile("cmd", ["/c", "start", "", url], () => {});
    } else {
      execFile("xdg-open", [url], () => {});
    }
  } catch {
    /* best effort only */
  }
}

/**
 * Reads a requested port from `--port <n>` / `--port=<n>` (checked first,
 * so it works with `node index.mjs --port 8080` and, via npm's argument
 * passthrough, `npm start -- --port 8080`), then falls back to a PORT
 * environment variable, then 0 (let the OS pick a free port).
 */
function resolveRequestedPort() {
  const argv = process.argv.slice(2);
  const spaceIdx = argv.indexOf("--port");
  if (spaceIdx !== -1 && argv[spaceIdx + 1]) {
    const n = parseInt(argv[spaceIdx + 1], 10);
    if (Number.isInteger(n) && n > 0 && n < 65536) return n;
    log(`Ignoring invalid --port value "${argv[spaceIdx + 1]}" - expected a number between 1 and 65535.`);
  }
  const eqArg = argv.find((a) => a.startsWith("--port="));
  if (eqArg) {
    const n = parseInt(eqArg.slice("--port=".length), 10);
    if (Number.isInteger(n) && n > 0 && n < 65536) return n;
    log(`Ignoring invalid --port value "${eqArg}" - expected a number between 1 and 65535.`);
  }
  if (process.env.PORT) {
    const n = parseInt(process.env.PORT, 10);
    if (Number.isInteger(n) && n > 0 && n < 65536) return n;
  }
  return 0;
}

async function startDashboardServer(requestedPort) {
  const server = nodeHttp.createServer((req, res) => {
    dashboardRequestHandler(req, res).catch((err) => {
      log(`Unhandled dashboard error: ${err}`);
      try {
        sendJson(res, 500, { error: String(err) });
      } catch {
        /* response may already be sent/closed */
      }
    });
  });

  try {
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(requestedPort, "127.0.0.1", resolve);
    });
  } catch (err) {
    if (requestedPort === 0) throw err; // auto-pick itself failing means something else is wrong
    log(`Could not start the dashboard on port ${requestedPort} (${err.code || err.message}) - picking a free port instead.`);
    server.removeAllListeners("error");
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
  }

  const { port } = server.address();
  const url = `http://127.0.0.1:${port}`;
  // Unmissable even if the rest of the log scrolls by - this is the one
  // line a person watching the terminal most needs to see.
  console.log(`\nDashboard: ${url}\n`);
  log(`Dashboard running at ${url}`);
  openInBrowser(url);
  return server;
}

async function bootstrapScheduler() {
  try {
    const activities = await readActivities();
    await buildPendingQueueIfMissing(activities);
  } catch (err) {
    log(`No usable activities.json yet (${err.message}). Use the dashboard to add your first activity.`);
  }

  sessionWatchdog(); // fire-and-forget background loop

  await scanAndSchedule();
  setInterval(scanAndSchedule, HEARTBEAT_INTERVAL_MS);
}

async function logStartupPaths() {
  log(`App directory: ${APP_DIR}`);
  log(`Reading activities from: ${ACTIVITIES_PATH}`);
  log(`Storing state (pending.json, auth.json, app.log, alerts.log) under: ${STORAGE_DIR}`);
}

async function main() {
  await ensureStateDir();
  await logStartupPaths();
  await startDashboardServer(resolveRequestedPort());
  await bootstrapScheduler();
  setInterval(trimLogFileIfLarge, APP_LOG_TRIM_INTERVAL_MS);
  log(`Scheduler running (heartbeat every ${HEARTBEAT_INTERVAL_MS / 1000}s). Press Ctrl+C to stop.`);
  await new Promise(() => {}); // keep the process alive; this is a persistent daemon now
}

process.on("SIGINT", () => {
  log("Shutting down.");
  process.exit(0);
});

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exitCode = 1;
});
