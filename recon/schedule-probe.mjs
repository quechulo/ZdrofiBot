// R7, R8: does plain HTTP return the schedule, and how fast? Also shows server
// headers that reveal a WAF. Run it on the temporary VM too. Read-only.
// Usage: node recon/schedule-probe.mjs --club <slug> [--session <name>] [--repeat 3] [--list]
// --list prints every class with its id, for choosing ids for the token and booking probes.
import { Jar, fail, http, parseArgs, parseSchedule, record, savePage, sleep } from "./lib.mjs";

const options = parseArgs();
if (!options.club) fail("Usage: node recon/schedule-probe.mjs --club <slug> [--session <name>] [--repeat 3]");
const repeat = Number(options.repeat ?? 1);
const jar = options.session ? new Jar(options.session) : null;

const REVEALING_HEADERS = ["server", "via", "x-powered-by", "cf-ray", "x-cache", "x-sucuri-id", "x-served-by"];

for (let attempt = 1; attempt <= repeat; attempt++) {
  const response = await http(jar, `/kluby-fitness/${options.club}/grafik-zajec`);
  const items = [...response.html.matchAll(/<li\b[^>]*\bdata-id="(\d+)"[^>]*>/g)];
  const classCounts = {};
  for (const [tag] of items) {
    const classes = tag.match(/class="([^"]*)"/)?.[1].split(/\s+/) ?? [];
    for (const name of classes) classCounts[name] = (classCounts[name] ?? 0) + 1;
  }
  const dates = [...new Set([...response.html.matchAll(/<time[^>]*datetime="(\d{4}-\d{2}-\d{2})/g)].map((m) => m[1]))].sort();
  const serverHeaders = Object.fromEntries(
    REVEALING_HEADERS.flatMap((header) => {
      const value = response.headers.get(header);
      return value ? [[header, value]] : [];
    }),
  );

  record("schedule", {
    attempt,
    anonymous: !jar,
    status: response.status,
    ms: response.ms,
    bytes: response.html.length,
    items: items.length,
    dates,
    classCounts,
    serverHeaders,
    page: attempt === 1 ? savePage("schedule", response.html) : undefined,
  });
  if (options.list && attempt === 1) {
    for (const item of parseSchedule(response.html)) {
      const status = item.closed ? "closed" : item.notOpenYet ? "not-open" : item.full ? "full" : "open";
      console.log(item.id, item.time, status.padEnd(8), (item.seats ?? "").padEnd(6), item.name);
    }
  }
  if (attempt < repeat) await sleep(2000);
}
