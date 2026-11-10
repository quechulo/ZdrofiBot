import fs from "node:fs";
import { describe, expect, it } from "vitest";

const ROOT = new URL("../../../", import.meta.url);
const WORKSPACE = "@zdrofibot/";

interface Manifest {
  dependencies?: Record<string, string>;
}

const manifest = (path: string): Manifest =>
  JSON.parse(fs.readFileSync(new URL(`${path}/package.json`, ROOT), "utf8")) as Manifest;

function allDependencies(path: string, seen = new Set<string>()): Set<string> {
  for (const name of Object.keys(manifest(path).dependencies ?? {})) {
    if (seen.has(name)) continue;
    seen.add(name);
    if (name.startsWith(WORKSPACE)) allDependencies(`libs/${name.slice(WORKSPACE.length)}`, seen);
  }
  return seen;
}

describe("fire-worker", () => {
  it("can't reach Playwright, so a browser can't block the event loop at T", () => {
    expect([...allDependencies("apps/fire-worker")]).not.toContain("playwright");
  });
});
