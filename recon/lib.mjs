// Shared helpers for the throwaway recon probes. See recon/README.md.
// Rule: cookie, token and password VALUES never reach stdout or a .jsonl file.
// Only fingerprints do. Secrets stay in OUT, which is gitignored and mode 0700.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const BASE = process.env.ZDROFIT_BASE_URL ?? "https://zdrofit.pl";
export const OUT = process.env.RECON_OUT ?? path.join(HERE, ".out");
const BASE_HOST = new URL(BASE).hostname;

fs.mkdirSync(path.join(OUT, "pages"), { recursive: true, mode: 0o700 });
fs.chmodSync(OUT, 0o700);

const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36";

export const fingerprint = (value) =>
  crypto.createHash("sha256").update(String(value)).digest("hex").slice(0, 8);

export const statePath = (name) => path.join(OUT, `state-${name}.json`);
export const metaPath = (name) => path.join(OUT, `meta-${name}.json`);
export const profilePath = (name) => path.join(OUT, `profile-${name}`);

export function writePrivate(file, content) {
  fs.writeFileSync(file, content, { mode: 0o600 });
  fs.chmodSync(file, 0o600);
}

/** Appends one result to .out/<log>.jsonl and echoes it. Only pass safe fields. */
export function record(log, entry) {
  const line = JSON.stringify({ at: new Date().toISOString(), ...entry });
  fs.appendFileSync(path.join(OUT, `${log}.jsonl`), `${line}\n`, { mode: 0o600 });
  console.log(line);
}

export function savePage(label, html) {
  const safe = label.replace(/[^a-z0-9-]+/gi, "_");
  const file = path.join(OUT, "pages", `${Date.now()}-${safe}.html`);
  writePrivate(file, html);
  return path.relative(OUT, file);
}

const belongsToPortal = (domain) => {
  const bare = domain.replace(/^\./, "");
  return BASE_HOST === bare || BASE_HOST.endsWith(`.${bare}`);
};

/** A minimal cookie jar over a Playwright storageState file. */
export class Jar {
  constructor(name) {
    this.name = name;
    this.state = JSON.parse(fs.readFileSync(statePath(name), "utf8"));
  }

  header() {
    return this.state.cookies
      .filter((c) => belongsToPortal(c.domain))
      .map((c) => `${c.name}=${c.value}`)
      .join("; ");
  }

  sessionFingerprint() {
    const session = this.state.cookies.find((c) => c.name === "SULUSESSID");
    return session ? fingerprint(session.value) : null;
  }

  /** Applies a Set-Cookie header and returns a value-free description of the change. */
  apply(setCookie) {
    const [pair, ...attributes] = setCookie.split(";");
    const separator = pair.indexOf("=");
    const name = pair.slice(0, separator).trim();
    const value = pair.slice(separator + 1).trim();
    const attrs = attributes.map((a) => a.trim().toLowerCase());
    const maxAge = attrs.find((a) => a.startsWith("max-age="))?.split("=")[1];
    const hasExpiry = maxAge !== undefined || attrs.some((a) => a.startsWith("expires="));
    const deleted = maxAge === "0" || value === "" || value === "deleted";

    const existing = this.state.cookies.find((c) => c.name === name && belongsToPortal(c.domain));
    let change;
    if (deleted) {
      change = "deleted";
      this.state.cookies = this.state.cookies.filter((c) => c !== existing);
    } else if (!existing) {
      change = "added";
      this.state.cookies.push({
        name, value, domain: BASE_HOST, path: "/", expires: -1,
        httpOnly: attrs.includes("httponly"), secure: attrs.includes("secure"), sameSite: "Lax",
      });
    } else {
      change = existing.value === value ? "unchanged" : "rotated";
      existing.value = value;
    }
    return { name, change, valueFp: fingerprint(value), persistent: hasExpiry, maxAge: maxAge ?? null };
  }

  save() {
    writePrivate(statePath(this.name), JSON.stringify(this.state));
  }
}

/** fetch with manual redirects, so a Set-Cookie on any hop reaches the jar. */
export async function http(jar, target, { method = "GET", form, headers = {}, timeoutMs = 30_000 } = {}) {
  let url = new URL(target, BASE).href;
  let currentMethod = method;
  let body = form ? new URLSearchParams(form).toString() : undefined;
  const setCookies = [];
  const started = performance.now();
  let response;

  for (let hop = 0; ; hop++) {
    const cookie = jar?.header();
    response = await fetch(url, {
      method: currentMethod,
      redirect: "manual",
      body,
      signal: AbortSignal.timeout(timeoutMs),
      headers: {
        "User-Agent": USER_AGENT,
        Accept: "text/html,application/xhtml+xml,*/*;q=0.8",
        "Accept-Language": "pl-PL,pl;q=0.9,en-US;q=0.8,en;q=0.7",
        ...(body ? { "Content-Type": "application/x-www-form-urlencoded" } : {}),
        ...(cookie ? { Cookie: cookie } : {}),
        ...headers,
      },
    });

    for (const value of response.headers.getSetCookie()) {
      if (jar) setCookies.push(jar.apply(value));
      else setCookies.push({ name: value.split("=")[0], change: "anonymous" });
    }

    const location = response.headers.get("location");
    if (response.status < 300 || response.status >= 400 || !location || hop >= 5) break;
    await response.arrayBuffer();
    url = new URL(location, url).href;
    if ([301, 302, 303].includes(response.status)) {
      currentMethod = "GET";
      body = undefined;
    }
  }

  const html = await response.text();
  return {
    status: response.status,
    url,
    html,
    ms: Math.round(performance.now() - started),
    setCookies,
    headers: response.headers,
  };
}

// Ported from index.mjs:463-478 with two fixes. A bare "/logout" substring also
// matches inline scripts on logged-out pages, so require a real link. And
// "unknown" is new: the MVP treated any page not clearly logged-out as live.
export const isAuthenticatedHtml = (html) =>
  html.includes("Wyloguj się") || /<a\b[^>]*\bhref="[^"]*logout/i.test(html);

export function classifySession({ status, url, html }) {
  if (isAuthenticatedHtml(html)) return "authenticated";
  const loginPage =
    html.includes("member_login_form") || html.includes("g-recaptcha-response");
  if (status === 401 || status === 403 || url.includes("/login") || loginPage) return "logged-out";
  return "unknown";
}

/**
 * Symfony re-masks the CSRF token on every render as "<noise>.<key>.<masked>",
 * so two renders look different even when the real token is the same. XOR-ing
 * with the key recovers it. Returns null for any other format.
 */
export function tokenCore(token) {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const key = Buffer.from(parts[1], "base64url");
  const masked = Buffer.from(parts[2], "base64url");
  if (key.length === 0 || masked.length === 0) return null;
  return Buffer.from(masked.map((byte, i) => byte ^ key[i % key.length])).toString("utf8");
}

export function parseToken(html) {
  return html.match(/name="schedule_register_form\[_token\]"\s+value="([^"]+)"/)?.[1] ?? null;
}

/** Reads schedule rows from the page. Mirrors what libs/portal will do with cheerio. */
export function parseSchedule(html) {
  return html.split(/(?=<li\b[^>]*\bdata-id=")/).slice(1).map((chunk) => {
    const tag = chunk.slice(0, chunk.indexOf(">"));
    const [taken, capacity] = chunk.match(/data-icon-alt="uczestnicy">\s*(\d+)\/(\d+)/)?.slice(1) ?? [];
    return {
      id: tag.match(/data-id="(\d+)"/)[1],
      time: chunk.match(/<time[^>]*datetime="([^"]+)"/)?.[1] ?? null,
      name: chunk.match(/class="activity"[^>]*>([^<]+)/)?.[1].trim() ?? null,
      notOpenYet: /item-registration-early/.test(tag),
      closed: /item-registration-late/.test(tag),
      full: /data-full="true"/.test(tag),
      seats: taken ? `${taken}/${capacity}` : null,
    };
  });
}

export function parseArgs(argv = process.argv.slice(2)) {
  const options = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith("--")) {
      options._.push(arg);
      continue;
    }
    const key = arg.slice(2);
    const next = argv[i + 1];
    const value = next === undefined || next.startsWith("--") ? true : argv[++i];
    if (key in options) options[key] = [options[key], value].flat();
    else options[key] = value;
  }
  return options;
}

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export function fail(message) {
  console.error(message);
  process.exit(1);
}
