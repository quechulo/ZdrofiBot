// R4 (read-only): is the registration CSRF token on the class page before opening?
// Usage:
//   node recon/token-probe.mjs <session-name> --club <slug> --id <id> [--id <id2>]
//   node recon/token-probe.mjs <session-name> --club <slug> --id <id> --around <ISO time of T>
// --around polls every 15 s from T-60 s to T+30 s, to see when the form appears.
import { Jar, classifySession, fail, fingerprint, http, parseArgs, parseToken, record, savePage, sleep, tokenCore } from "./lib.mjs";

const options = parseArgs();
const [name] = options._;
const ids = [options.id].flat().filter(Boolean);
if (!name || !options.club || ids.length === 0) {
  fail("Usage: node recon/token-probe.mjs <session-name> --club <slug> --id <id> [--id <id2>] [--around <ISO>]");
}

const jar = new Jar(name);

async function probe(id, label = "") {
  const response = await http(jar, `/kluby-fitness/${options.club}/grafik-zajec/${id}`);
  const token = parseToken(response.html);
  jar.save();
  record("token", {
    id,
    label,
    state: classifySession(response),
    status: response.status,
    ms: response.ms,
    tokenPresent: Boolean(token),
    tokenFp: token ? fingerprint(token) : null,
    tokenCoreFp: token && tokenCore(token) ? fingerprint(tokenCore(token)) : null,
    page: savePage(`token-${id}${label}`, response.html),
  });
}

if (options.around) {
  const target = new Date(options.around).getTime();
  if (Number.isNaN(target)) fail("--around needs an ISO time, such as 2026-11-08T18:00:00+01:00");
  for (let offset = -60; offset <= 30; offset += 15) {
    await sleep(target + offset * 1000 - Date.now());
    await probe(ids[0], `T${offset >= 0 ? "+" : ""}${offset}s`);
  }
} else {
  for (const id of ids) {
    await probe(id, "a");
    await probe(id, "b");
  }
}
