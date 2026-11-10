// R1: how long does a session live, and do responses rotate its cookie?
// Usage:
//   node recon/session-watch.mjs <session-name> --every 5     poll every 5 minutes
//   node recon/session-watch.mjs <session-name> --at 60       one check, 60 min after login
// Stops at the first logged-out result and reports the lifetime bounds.
import fs from "node:fs";
import { Jar, classifySession, fail, http, metaPath, parseArgs, record, sleep, statePath } from "./lib.mjs";

const options = parseArgs();
const [name] = options._;
const everyMin = options.every === undefined ? null : Number(options.every);
const atMin = options.at === undefined ? null : Number(options.at);
if (!name || (everyMin === null) === (atMin === null) || Number.isNaN(everyMin ?? atMin)) {
  fail("Usage: node recon/session-watch.mjs <session-name> (--every <minutes> | --at <minutes>)");
}
if (!fs.existsSync(statePath(name))) fail(`No session "${name}". Run recon/login.mjs first.`);

const { loggedInAt } = JSON.parse(fs.readFileSync(metaPath(name), "utf8"));
const loginMs = new Date(loggedInAt).getTime();
const jar = new Jar(name);
const ageMin = () => Number(((Date.now() - loginMs) / 60_000).toFixed(1));

let lastOkAge = null;
let previousCheckAt = null;

async function check() {
  const before = jar.sessionFingerprint();
  try {
    const response = await http(jar, "/zajecia");
    const state = classifySession(response);
    jar.save();
    const after = jar.sessionFingerprint();
    record("session", {
      session: name,
      ageMin: ageMin(),
      state,
      status: response.status,
      ms: response.ms,
      sessionRotated: before !== after,
      setCookies: response.setCookies.filter((c) => c.change !== "unchanged"),
    });
    return state;
  } catch (error) {
    record("session", { session: name, ageMin: ageMin(), state: "error", error: error.name });
    return "error";
  }
}

if (atMin !== null) {
  const wait = loginMs + atMin * 60_000 - Date.now();
  if (wait < 0) fail(`Session is already ${ageMin()} min old, past --at ${atMin}.`);
  console.log(`Idle until ${atMin} min after login, then one check.`);
  await sleep(wait);
  await check();
  process.exit(0);
}

const intervalMs = everyMin * 60_000;
for (;;) {
  if (previousCheckAt && Date.now() - previousCheckAt > intervalMs * 2) {
    // A sleeping laptop would otherwise look like an idle-timeout result.
    record("session", {
      session: name,
      event: "gap-detected",
      gapMin: Number(((Date.now() - previousCheckAt) / 60_000).toFixed(1)),
    });
  }
  previousCheckAt = Date.now();
  const state = await check();
  if (state === "authenticated") lastOkAge = ageMin();
  if (state === "logged-out") {
    record("session", {
      session: name,
      event: "session-ended",
      lifetimeMinBetween: [lastOkAge, ageMin()],
    });
    break;
  }
  await sleep(intervalMs);
}
