// R2, R3: manual login in a headful browser with a persistent profile.
// Records form field names and reCAPTCHA signals, never field values.
// Usage: node recon/login.mjs <session-name>
import { chromium } from "playwright";
import {
  BASE, fail, isAuthenticatedHtml, metaPath, parseArgs, profilePath, record, sleep, statePath, writePrivate,
} from "./lib.mjs";
import fs from "node:fs";

const { _: [name] } = parseArgs();
if (!name) fail("Usage: node recon/login.mjs <session-name>");

const LOGIN_TIMEOUT_MS = 5 * 60 * 1000;

const context = await chromium.launchPersistentContext(profilePath(name), {
  headless: process.env.RECON_HEADLESS === "1",
  viewport: { width: 1280, height: 900 },
});
const page = context.pages()[0] ?? (await context.newPage());
await page.goto(`${BASE}/#logowanie`, { waitUntil: "domcontentloaded" });
await sleep(3000);

const inspectForm = () =>
  page.evaluate(() => {
    const fields = [...document.querySelectorAll('input[name^="member_login_form"], select[name^="member_login_form"]')]
      .map((el) => ({ name: el.name, type: el.type }));
    const widgets = [...document.querySelectorAll(".g-recaptcha, [data-sitekey]")].map((el) => ({
      size: el.getAttribute("data-size"),
      callback: Boolean(el.getAttribute("data-callback")),
    }));
    const scripts = [...document.scripts].map((s) => s.src).filter((s) => /recaptcha/.test(s))
      .map((s) => {
        const url = new URL(s);
        const render = url.searchParams.get("render");
        return { path: url.pathname, render: render && render !== "explicit" ? "site-key" : render };
      });
    const frames = [...document.querySelectorAll('iframe[src*="recaptcha"]')].map((f) => {
      const url = new URL(f.src);
      return { path: url.pathname, size: url.searchParams.get("size") };
    });
    return { fields, widgets, scripts, frames };
  });

record("login", { event: "login-form", session: name, ...(await inspectForm()) });
console.log("\nLog in by hand in the browser window. Tick 'remember me' if the form has it.\n");

const startedAt = Date.now();
let challengeShown = false;
let authenticated = false;

while (Date.now() - startedAt < LOGIN_TIMEOUT_MS) {
  try {
    challengeShown ||= await page.evaluate(() =>
      [...document.querySelectorAll('iframe[src*="recaptcha/api2/bframe"], iframe[src*="recaptcha/enterprise/bframe"]')]
        .some((frame) => {
          const box = frame.getBoundingClientRect();
          return box.width > 100 && box.height > 100 && getComputedStyle(frame).visibility !== "hidden";
        }));
    if (isAuthenticatedHtml(await page.content())) {
      authenticated = true;
      break;
    }
  } catch {
    // The page is navigating. Try again on the next tick.
  }
  await sleep(1000);
}

if (!authenticated) {
  record("login", { event: "login-timeout", session: name, challengeShown });
  await context.close();
  process.exit(1);
}

await sleep(1500);
const state = await context.storageState();
writePrivate(statePath(name), JSON.stringify(state));
const loggedInAt = new Date().toISOString();
writePrivate(metaPath(name), JSON.stringify({ loggedInAt }));

const host = new URL(BASE).hostname;
const portalCookies = state.cookies
  .filter((c) => host.endsWith(c.domain.replace(/^\./, "")))
  .map((c) => ({
    name: c.name,
    httpOnly: c.httpOnly,
    lifetimeDays: c.expires > 0 ? Math.round((c.expires - Date.now() / 1000) / 86400) : "session",
  }));

record("login", {
  event: "login-ok",
  session: name,
  tookSeconds: Math.round((Date.now() - startedAt) / 1000),
  challengeShown,
  rememberCookie: portalCookies.some((c) => /remember/i.test(c.name)),
  portalCookies,
});

await context.close();
if (!fs.existsSync(statePath(name))) fail("State file was not written.");
