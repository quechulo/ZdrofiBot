// Builds committed test fixtures from pages saved by the probes. It copies only
// allowlisted fragments, never whole pages: logged-in pages embed the member's
// email in an analytics block outside <main>. Tokens and names are replaced, and
// the script fails if anything personal or a real token survives.
// Usage: node recon/make-fixtures.mjs
import fs from "node:fs";
import path from "node:path";
import { OUT } from "./lib.mjs";

const TARGET = path.join(import.meta.dirname, "..", "test", "mock-portal", "fixtures");
const pages = fs.readdirSync(path.join(OUT, "pages")).sort();
const read = (pattern, pick = (found) => found[0]) => {
  const file = pick(pages.filter((name) => pattern.test(name)));
  if (!file) throw new Error(`No saved page matches ${pattern}`);
  return fs.readFileSync(path.join(OUT, "pages", file), "utf8");
};

// Same "noise.key.masked" shape as Symfony, but with a made-up value.
const fakeKey = Buffer.alloc(32, 7);
const fakeCore = "fixture-token-core-not-a-real-csrf-token-000";
const fakeMasked = Buffer.from([...Buffer.from(fakeCore)].map((byte, i) => byte ^ fakeKey[i % 32]));
const FAKE_TOKEN = `abcd.${fakeKey.toString("base64url")}.${fakeMasked.toString("base64url")}`;

const scrub = (html) =>
  html
    .replace(/(name="(?:schedule_register_form|schedule_unregister_form|member_login_form)\[_token\]"\s+value=")[^"]*/g, `$1${FAKE_TOKEN}`)
    .replace(/(data-trainer=")[^"]*/g, "$1trener_testowy")
    .replace(/(href="[^"]*\/kadra\/)[^"#]*/g, "$1trener-testowy")
    .replace(/<a\b[^>]*class="trainer"[\s\S]*?<\/a>/g, (anchor) =>
      `${anchor.slice(0, anchor.indexOf(">") + 1)}<img src="/uploads/trener-testowy.jpg" alt=""> Trener Testowy </a>`)
    .replace(/(data-recaptcha-sitekey=")[^"]*/g, "$1fixture-site-key")
    .replace(/\?v=[\d.\-]+/g, "");

const main = (html) => html.match(/<main\b[\s\S]*?<\/main>/)?.[0] ?? "";
const loggedIn = (body) =>
  `<!doctype html><html lang="pl"><body><header><a href="/logout">Wyloguj się</a></header>${scrub(body)}</body></html>\n`;

// The first snapshot is anonymous, so it has the login form. The pinned one was
// taken in the daytime, so it has classes in every state. Pinned, so later
// probe runs can't silently change what the tests see.
const anonymous = read(/-schedule\.html$/, (found) => found[0]);
const schedule = read(/1793965004911-schedule\.html$/);
const items = schedule.match(/<li id="schedule-item-[\s\S]*?<\/li>/g);
const pickItem = (test, count = 2) => items.filter(test).slice(0, count);
const chosen = [
  ...pickItem((li) => /item-registration-late/.test(li)),
  ...pickItem((li) => /item-registration-early/.test(li)),
  ...pickItem((li) => !/item-registration-(late|early)/.test(li) && /data-full="false"/.test(li)),
  ...pickItem((li) => !/item-registration-(late|early)/.test(li) && /data-full="true"/.test(li)),
];
const loginForm = anonymous.match(/<form\b[^>]*name="member_login_form"[\s\S]*?<\/form>/)?.[0] ?? "";

const files = {
  "schedule.html": `<!doctype html><html lang="pl"><body>${scrub(loginForm)}<section id="schedule-rano"><ul>${scrub(chosen.join("\n"))}</ul></section></body></html>\n`,
  "class-open.html": loggedIn(main(read(/token-2546335a/))),
  "class-not-open.html": loggedIn(main(read(/token-2558765a/))),
  "class-booked.html": loggedIn(main(read(/book-2544368/))),
  "post-not-open.html": loggedIn(main(read(/book-2558759/))),
  "class-unregister.html": loggedIn(main(read(/account-map/, (found) =>
    found.find((name) => fs.readFileSync(path.join(OUT, "pages", name), "utf8").includes("schedule_unregister_form"))))),
};

const forbidden = [/@gmail/i, /user_email/i, /c2c75173/, /\b[\w.+-]+@[\w-]+\.[a-z]{2,}\b/i, /f04ad459/, /Dąbrowa|Czołak|Przybyszewska|Tkachenko/];
const realTokens = new Set();
for (const name of pages) {
  const html = fs.readFileSync(path.join(OUT, "pages", name), "utf8");
  for (const [, token] of html.matchAll(/\[_token\]"\s+value="([^"]+)"/g)) realTokens.add(token);
}

fs.mkdirSync(TARGET, { recursive: true });
for (const [name, html] of Object.entries(files)) {
  for (const pattern of forbidden) {
    if (pattern.test(html)) throw new Error(`${name} still matches ${pattern}`);
  }
  for (const token of realTokens) {
    if (html.includes(token)) throw new Error(`${name} contains a real token`);
  }
  fs.writeFileSync(path.join(TARGET, name), html);
  console.log(name.padEnd(24), html.length);
}
console.log(`Checked against ${realTokens.size} real tokens. Items: ${chosen.length}`);
