import http from "node:http";
import type { AddressInfo } from "node:net";
import { telegramLinkCodes, users } from "@zdrofibot/db";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { addUser, createWorld, MINUTE, type TestWorld } from "../../test/support.js";
import { TelegramClient, TelegramError, type TelegramUpdate } from "./client.js";
import { REPLIES, TelegramLinker } from "./linker.js";
import { TelegramNotifier } from "./notifier.js";

const TOKEN = "123456:secret-bot-token";

/** Just enough of the Bot API. */
class FakeBotApi {
  calls: Array<{ method: string; body: Record<string, unknown> }> = [];
  updates: TelegramUpdate[] = [];
  failSends = false;
  private server = http.createServer((request, response) => void this.handle(request, response));

  async start(): Promise<string> {
    await new Promise<void>((resolve) => this.server.listen(0, "127.0.0.1", resolve));
    return `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
  }

  async stop(): Promise<void> {
    this.server.closeAllConnections();
    await new Promise((resolve) => this.server.close(resolve));
  }

  sentTexts(): string[] {
    return this.calls.filter((call) => call.method === "sendMessage").map((call) => String(call.body.text));
  }

  private async handle(request: http.IncomingMessage, response: http.ServerResponse) {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(chunk as Buffer);
    const match = /^\/bot([^/]+)\/(\w+)$/.exec(request.url ?? "");
    const reply = (body: object) => {
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify(body));
    };
    if (!match || match[1] !== TOKEN) return reply({ ok: false, error_code: 401, description: "Unauthorized" });
    const method = match[2]!;
    const body = JSON.parse(Buffer.concat(chunks).toString() || "{}") as Record<string, unknown>;
    this.calls.push({ method, body });
    if (method === "getMe") return reply({ ok: true, result: { id: 1, username: "zdrofi_test_bot" } });
    if (method === "sendMessage") {
      if (this.failSends) return reply({ ok: false, error_code: 403, description: "Forbidden: bot was blocked by the user" });
      return reply({ ok: true, result: { message_id: 1 } });
    }
    if (method === "getUpdates") {
      const pending = this.updates.filter((update) => update.update_id >= Number(body.offset ?? 0));
      this.updates = [];
      return reply({ ok: true, result: pending });
    }
    reply({ ok: false, description: "Unknown method" });
  }
}

let world: TestWorld;
let api: FakeBotApi;
let telegram: TelegramClient;
let userId: string;

const start = (text: string, updateId = 1, chatType = "private"): TelegramUpdate => ({
  update_id: updateId,
  message: { message_id: updateId, text, chat: { id: 777, type: chatType } },
});
const codeOf = (link: string) => new URL(link).searchParams.get("start")!;
const chatIdOf = async () => (await world.db.select().from(users).where(eq(users.id, userId)))[0]!.telegramChatId;

beforeEach(async () => {
  world = await createWorld();
  api = new FakeBotApi();
  telegram = new TelegramClient(TOKEN, await api.start());
  userId = (await addUser(world, null)).userId;
});

afterEach(async () => {
  await api.stop();
  await world.portal.stop();
});

describe("Telegram linking", () => {
  it("binds the chat that presses Start on a fresh link, and stores the code only hashed", async () => {
    const linker = new TelegramLinker(world.db, telegram, world.log);
    const link = await linker.createLink(userId);
    expect(link).toMatch(/^https:\/\/t\.me\/zdrofi_test_bot\?start=[A-Za-z0-9_-]{32}$/);
    const [stored] = await world.db.select().from(telegramLinkCodes);
    expect(stored!.codeHash).not.toContain(codeOf(link));

    await linker.handleUpdate(start(`/start ${codeOf(link)}`));

    expect(await chatIdOf()).toBe("777");
    expect(api.sentTexts()).toEqual([REPLIES.linked]);
  });

  it("refuses a link used twice or expired", async () => {
    const linker = new TelegramLinker(world.db, telegram, world.log);
    const used = await linker.createLink(userId);
    await linker.handleUpdate(start(`/start ${codeOf(used)}`));
    await linker.handleUpdate(start(`/start ${codeOf(used)}`, 2));

    const old = await linker.createLink(userId, new Date(Date.now() - 31 * MINUTE));
    await linker.handleUpdate(start(`/start ${codeOf(old)}`, 3));

    expect(api.sentTexts()).toEqual([REPLIES.linked, REPLIES.invalid, REPLIES.invalid]);
  });

  it("answers other messages, and ignores groups", async () => {
    const linker = new TelegramLinker(world.db, telegram, world.log);
    await linker.handleUpdate(start("hello"));
    await linker.handleUpdate(start("/start abc", 2, "group"));
    expect(api.sentTexts()).toEqual([REPLIES.other]);
    expect(await chatIdOf()).toBeNull();
  });

  it("handles updates from long polling, each once", async () => {
    const linker = new TelegramLinker(world.db, telegram, world.log);
    const link = await linker.createLink(userId);
    api.updates = [start(`/start ${codeOf(link)}`, 10)];
    const stop = new AbortController();

    const polling = linker.poll(stop.signal);
    while ((await chatIdOf()) === null) await new Promise((resolve) => setTimeout(resolve, 10));
    stop.abort();
    await polling;

    const offsets = api.calls.filter((call) => call.method === "getUpdates").map((call) => call.body.offset);
    expect(offsets.slice(0, 2)).toEqual([0, 11]);
  });
});

describe("TelegramNotifier", () => {
  it("reports users without a linked chat", async () => {
    const notifier = new TelegramNotifier(world.db, telegram, world.log);
    expect(await notifier.send(userId, { text: "hi" })).toBe("no-channel");
  });

  it("sends to the linked chat, with a button", async () => {
    await world.db.update(users).set({ telegramChatId: "777" }).where(eq(users.id, userId));
    const notifier = new TelegramNotifier(world.db, telegram, world.log);

    expect(await notifier.send(userId, { text: "hi", button: { text: "Reconnect", url: "https://x.test" } })).toBe("sent");
    expect(api.calls.at(-1)!.body).toMatchObject({
      chat_id: "777",
      text: "hi",
      reply_markup: { inline_keyboard: [[{ text: "Reconnect", url: "https://x.test" }]] },
    });
  });

  it("reports a refused send as failed, so the ladder retries", async () => {
    await world.db.update(users).set({ telegramChatId: "777" }).where(eq(users.id, userId));
    api.failSends = true;
    expect(await new TelegramNotifier(world.db, telegram, world.log).send(userId, { text: "hi" })).toBe("failed");
  });
});

describe("TelegramClient", () => {
  it("never puts the bot token in an error", async () => {
    const unreachable = new TelegramClient(TOKEN, "http://127.0.0.1:1");
    const error = await unreachable.getMe().catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(TelegramError);
    expect(String((error as Error).message)).not.toContain("secret-bot-token");
    expect(JSON.stringify(error)).not.toContain("secret-bot-token");
  });
});
