// R6: lists logged-in pages and forms, to find "my bookings" and cancellation.
// Usage: node recon/account-map.mjs <session-name> [--path /some/page]
import { BASE, Jar, classifySession, fail, http, parseArgs, record, savePage } from "./lib.mjs";

const options = parseArgs();
const [name] = options._;
if (!name) fail("Usage: node recon/account-map.mjs <session-name> [--path /some/page]");

const jar = new Jar(name);
const path = options.path ?? "/";
const response = await http(jar, path);
jar.save();

const origin = new URL(BASE).origin;
const links = new Set();
for (const [, href] of response.html.matchAll(/<a\b[^>]*\bhref="([^"#]+)/g)) {
  const url = new URL(href, origin);
  if (url.origin === origin && /konto|moj|profil|rezerw|zapis|member|klient|panel|logout|wyloguj/i.test(url.pathname)) {
    links.add(url.pathname);
  }
}

record("account-map", {
  path,
  state: classifySession(response),
  status: response.status,
  candidateLinks: [...links].sort(),
  forms: [...new Set([...response.html.matchAll(/<form\b[^>]*\bname="([^"]+)"/g)].map((m) => m[1]))],
  page: savePage("account-map", response.html),
});
