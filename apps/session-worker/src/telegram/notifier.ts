import { users, type AnyDatabase } from "@zdrofibot/db";
import { eq } from "drizzle-orm";
import type { Log } from "../log.js";
import type { InlineButton, TelegramClient } from "./client.js";

export type SendResult = "sent" | "no-channel" | "failed";

export interface OutgoingMessage {
  text: string;
  button?: InlineButton;
}

/** Small on purpose, so another channel (email) can be added or swapped in. */
export interface Notifier {
  readonly channel: string;
  send(userId: string, message: OutgoingMessage): Promise<SendResult>;
}

export class TelegramNotifier implements Notifier {
  readonly channel = "telegram";

  constructor(
    private readonly db: AnyDatabase,
    private readonly telegram: TelegramClient,
    private readonly log: Log,
  ) {}

  async send(userId: string, message: OutgoingMessage): Promise<SendResult> {
    const [user] = await this.db.select({ chatId: users.telegramChatId }).from(users).where(eq(users.id, userId));
    if (!user?.chatId) return "no-channel";
    try {
      await this.telegram.sendMessage(user.chatId, message.text, message.button);
      return "sent";
    } catch (error) {
      this.log.error(`Telegram send to user ${userId} failed: ${error instanceof Error ? error.message : "unknown"}`);
      return "failed";
    }
  }
}

/** Used until a bot token is set. */
export class LogNotifier implements Notifier {
  readonly channel = "log";

  constructor(private readonly log: Log) {}

  async send(userId: string, message: OutgoingMessage): Promise<SendResult> {
    this.log.warn(`Alert for user ${userId} (no Telegram configured): ${message.text}`);
    return "no-channel";
  }
}
