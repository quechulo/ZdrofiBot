import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { addActivity, addJob, addUser, createWorld, MINUTE, type TestWorld } from "../test/support.js";
import { KeepAlive } from "./keep-alive.js";
import { AlertLadder } from "./ladder.js";
import type { Notifier, OutgoingMessage, SendResult } from "./telegram/notifier.js";

class FakeNotifier implements Notifier {
  readonly channel = "fake";
  sent: Array<{ userId: string; message: OutgoingMessage }> = [];
  nextResult: SendResult = "sent";
  async send(userId: string, message: OutgoingMessage): Promise<SendResult> {
    const result = this.nextResult;
    this.nextResult = "sent";
    if (result === "sent") this.sent.push({ userId, message });
    return result;
  }
  get texts() {
    return this.sent.map((entry) => entry.message.text);
  }
}

const T = new Date("2026-11-20T17:00:00Z");
const at = (minutesBefore: number) => new Date(T.getTime() - minutesBefore * MINUTE);

let world: TestWorld;
let notifier: FakeNotifier;
let user: { userId: string; accountId: string };

function ladder(reconnectUrl: string | null = null) {
  const keepAlive = new KeepAlive(world.db, world.vault, world.portalOptions, world.log);
  return new AlertLadder(world.db, world.vault, keepAlive, notifier, { reconnectUrl }, world.log);
}

/** Puts the session in a known state, as seen at `checkedAt`. */
async function sessionIs(state: "ok" | "dead", checkedAt: Date) {
  if (state === "ok") {
    await world.vault.storeLogin(user.accountId, (await world.vault.loadStorageState(user.accountId))!, checkedAt);
  } else {
    const { version } = (await world.vault.loadSession(user.accountId))!;
    await world.vault.markEnded(user.accountId, version, checkedAt, "test");
  }
}

beforeEach(async () => {
  world = await createWorld();
  notifier = new FakeNotifier();
  user = await addUser(world, "s1");
  await addActivity(world, 401, T, "Pilates");
  await addJob(world, user.userId, 401, T);
});

afterEach(() => world.portal.stop());

describe("AlertLadder", () => {
  it("stays quiet while the session works", async () => {
    await sessionIs("ok", at(61));
    for (const minutes of [60, 30, 15, 10, 5]) await ladder().run(at(minutes));
    expect(notifier.sent).toHaveLength(0);
  });

  it("alerts once per rung while the session stays dead", async () => {
    await sessionIs("dead", at(90));
    for (const minutes of [59, 58, 45, 29, 14, 10, 9, 5, 1]) await ladder().run(at(minutes));

    expect(notifier.texts).toHaveLength(5);
    expect(notifier.texts[0]).toContain("Pilates");
    expect(notifier.texts[0]).toContain("opens in 59 min");
    expect(notifier.texts[4]).toContain("opens in 5 min");
  });

  it("alerts at once when the problem appears mid-ladder", async () => {
    await sessionIs("ok", at(61));
    await ladder().run(at(55));
    await sessionIs("dead", at(23));

    await ladder().run(at(22));

    expect(notifier.texts).toHaveLength(1);
    expect(notifier.texts[0]).toContain("opens in 22 min");
  });

  it("sends one 'all good' once the session works again", async () => {
    await sessionIs("dead", at(90));
    await ladder().run(at(59));
    await sessionIs("ok", at(40));

    await ladder().run(at(39));
    await ladder().run(at(29));

    expect(notifier.texts).toHaveLength(2);
    expect(notifier.texts[1]).toContain("All good");
  });

  it("retries a failed send on the next run", async () => {
    await sessionIs("dead", at(90));
    notifier.nextResult = "failed";
    await ladder().run(at(59));
    expect(notifier.sent).toHaveLength(0);

    await ladder().run(at(58));
    expect(notifier.sent).toHaveLength(1);
  });

  it("checks a session that hasn't been checked lately before deciding", async () => {
    await sessionIs("ok", at(120));
    world.portal.endSession("s1");

    await ladder().run(at(59));

    expect(notifier.sent).toHaveLength(1);
    expect((await world.vault.sessionStatus(user.accountId))!.state).toBe("NEEDS_USER");
  });

  it("ignores jobs more than an hour away", async () => {
    await sessionIs("dead", at(90));
    await ladder().run(at(61));
    expect(notifier.sent).toHaveLength(0);
  });

  it("runs one ladder per account, for its next job", async () => {
    await addActivity(world, 402, new Date(T.getTime() + 20 * MINUTE), "Joga");
    await addJob(world, user.userId, 402, new Date(T.getTime() + 20 * MINUTE));
    await sessionIs("dead", at(90));

    await ladder().run(at(40));

    expect(notifier.texts).toHaveLength(1);
    expect(notifier.texts[0]).toContain("Pilates");
  });

  it("adds a Reconnect button when assisted login exists", async () => {
    await sessionIs("dead", at(90));
    await ladder("https://bot.example/reconnect").run(at(59));
    expect(notifier.sent[0]!.message.button).toEqual({ text: "Reconnect", url: "https://bot.example/reconnect" });
  });
});
