// R4, R5: sends ONE real registration and saves the response. There is no retry.
// This creates a real booking, so cancel it at least 2 h before class, or it
// counts as a no-show (3 in 21 days blocks online booking for 7 days).
// After the POST it re-checks the session and logs any cookie change, including
// when the POST times out, to test whether a POST can end a session (Oct 26).
// Usage:
//   node recon/book-probe.mjs <session-name> --club <slug> --id <id> --i-will-cancel
//   add --token-from <other-id> to test whether a token works across classes
//   add --timeout-ms <n> to change the 45 s POST timeout
import { Jar, BASE, classifySession, fail, fingerprint, http, parseArgs, parseToken, record, savePage } from "./lib.mjs";

const options = parseArgs();
const [name] = options._;
if (!name || !options.club || !options.id) {
  fail("Usage: node recon/book-probe.mjs <session-name> --club <slug> --id <id> [--token-from <id>] --i-will-cancel");
}
if (options["i-will-cancel"] !== true) {
  fail("Refusing to book without --i-will-cancel. This makes a real reservation.");
}

const { club, id } = options;
const tokenSource = options["token-from"] ?? id;
const timeoutMs = Number(options["timeout-ms"] ?? 45_000);
const jar = new Jar(name);
const sessionBefore = jar.sessionFingerprint();
const changedCookies = (result) => result.setCookies.filter((c) => c.change !== "unchanged");

const page = await http(jar, `/kluby-fitness/${club}/grafik-zajec/${tokenSource}`);
// A logged-out page still offers a token, so check the session before using it.
const pageState = classifySession(page);
if (pageState !== "authenticated") {
  record("book", { id, tokenSource, outcome: "not-logged-in", status: page.status, state: pageState });
  jar.save();
  fail(`Session "${name}" is ${pageState}. Log in again with recon/login.mjs.`);
}

const token = parseToken(page.html);
if (!token) {
  record("book", { id, tokenSource, outcome: "no-token", status: page.status, state: classifySession(page) });
  jar.save();
  process.exit(1);
}

let response = null;
let postError = null;
try {
  response = await http(jar, `/grafik-zajec/${id}`, {
    method: "POST",
    timeoutMs,
    form: {
      "schedule_register_form[id]": id,
      "schedule_register_form[_redirect]": "",
      "schedule_register_form[_token]": token,
    },
    headers: {
      Origin: new URL(BASE).origin,
      Referer: `${new URL(BASE).origin}/kluby-fitness/${club}/grafik-zajec/${id}`,
    },
  });
} catch (error) {
  // A POST with no response is what preceded the Oct 26 session death.
  postError = error.name;
}
jar.save();

let sessionAfter;
try {
  const check = await http(jar, "/zajecia");
  jar.save();
  sessionAfter = { state: classifySession(check), ms: check.ms, setCookies: changedCookies(check) };
} catch (error) {
  sessionAfter = { state: "error", error: error.name };
}

record("book", {
  id,
  tokenSource,
  crossClassToken: String(tokenSource) !== String(id),
  tokenFp: fingerprint(token),
  postError,
  status: response?.status ?? null,
  finalPath: response ? new URL(response.url).pathname : null,
  ms: response?.ms ?? null,
  state: response ? classifySession(response) : null,
  markedRegistered: response
    ? new RegExp(`id="schedule-item-${id}"[\\s\\S]*?item-member-registered`, "i").test(response.html)
    : null,
  pageGetCookies: changedCookies(page),
  postCookies: response ? changedCookies(response) : [],
  sessionRotated: sessionBefore !== jar.sessionFingerprint(),
  sessionAfter,
  page: response ? savePage(`book-${id}`, response.html) : null,
});
if (postError) console.log("\nThe POST got no response, so the booking may still exist.");
console.log("\nCheck the real result on zdrofit.pl, then cancel at least 2 hours before class.");
