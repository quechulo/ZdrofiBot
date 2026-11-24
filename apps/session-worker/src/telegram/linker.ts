import crypto from "node:crypto";
import { setTimeout } from "node:timers/promises";
import { telegramLinkCodes, users, type AnyDatabase } from "@zdrofibot/db";
import { and, eq, gt, isNull } from "drizzle-orm";
import { describeError, type Log } from "../log.js";
import type { TelegramClient, TelegramUpdate } from "./client.js";

const LINK_TTL_MS = 30 * 60_000;
const POLL_TIMEOUT_SECONDS = 25;
const ERROR_BACKOFF_MS = 5_000;

const hash = (code: string) => crypto.createHash("sha256").update(code).digest("hex");

export const REPLIES = {
  linked: "Linked. Alerts about your classes will arrive here.",
  invalid: "This link has expired or was already used. Create a new one.",
  other: "This bot only sends alerts about your class registrations.",
};

/**
 * A bot can't message anyone first, so linking goes through a one-time Start
 * link: pressing Start sends "/start <code>", and the chat id is stored.
 */
export class TelegramLinker {
  private username: string | undefined;

  constructor(
    private readonly db: AnyDatabase,
    private readonly telegram: TelegramClient,
    private readonly log: Log,
  ) {}

  async createLink(userId: string, now = new Date()): Promise<string> {
    this.username ??= (await this.telegram.getMe()).username;
    // base64url fits Telegram's start parameter: up to 64 of A-Z, a-z, 0-9, _ and -.
    const code = crypto.randomBytes(24).toString("base64url");
    await this.db.insert(telegramLinkCodes).values({
      codeHash: hash(code),
      userId,
      expiresAt: new Date(now.getTime() + LINK_TTL_MS),
    });
    return `https://t.me/${this.username}?start=${code}`;
  }

  async handleUpdate(update: TelegramUpdate, now = new Date()): Promise<void> {
    const message = update.message;
    if (!message || message.chat.type !== "private") return;
    const chatId = String(message.chat.id);
    const code = /^\/start\s+([A-Za-z0-9_-]{1,64})$/.exec(message.text?.trim() ?? "")?.[1];
    if (!code) {
      await this.telegram.sendMessage(chatId, REPLIES.other);
      return;
    }

    const [used] = await this.db
      .update(telegramLinkCodes)
      .set({ usedAt: now })
      .where(
        and(
          eq(telegramLinkCodes.codeHash, hash(code)),
          isNull(telegramLinkCodes.usedAt),
          gt(telegramLinkCodes.expiresAt, now),
        ),
      )
      .returning({ userId: telegramLinkCodes.userId });
    if (!used) {
      await this.telegram.sendMessage(chatId, REPLIES.invalid);
      return;
    }
    await this.db.update(users).set({ telegramChatId: chatId }).where(eq(users.id, used.userId));
    this.log.log(`Telegram linked for user ${used.userId}`);
    await this.telegram.sendMessage(chatId, REPLIES.linked);
  }

  /** Long-polls until the signal aborts. Offsets acknowledge updates, so each is handled once. */
  async poll(signal: AbortSignal): Promise<void> {
    let offset = 0;
    while (!signal.aborted) {
      try {
        const updates = await this.telegram.getUpdates(offset, POLL_TIMEOUT_SECONDS, signal);
        for (const update of updates) {
          offset = update.update_id + 1;
          await this.handleUpdate(update).catch((error: unknown) =>
            this.log.error(`Telegram update failed: ${describeError(error)}`),
          );
        }
      } catch (error) {
        if (signal.aborted) return;
        this.log.error(`Telegram polling failed: ${describeError(error)}`);
        await setTimeout(ERROR_BACKOFF_MS, undefined, { signal }).catch(() => undefined);
      }
    }
  }
}
