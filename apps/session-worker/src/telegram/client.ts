import { fetch } from "undici";

export interface TelegramUpdate {
  update_id: number;
  message?: {
    message_id: number;
    text?: string;
    chat: { id: number; type: string };
    from?: { id: number };
  };
}

export interface InlineButton {
  text: string;
  url: string;
}

interface ApiResponse<T> {
  ok: boolean;
  result?: T;
  description?: string;
  error_code?: number;
}

/** Never carries the bot token, which is part of every request URL. */
export class TelegramError extends Error {
  override readonly name = "TelegramError";
  constructor(
    message: string,
    readonly code?: number,
  ) {
    super(message);
  }
}

/**
 * The official Bot API over plain HTTPS. Messages aren't end-to-end encrypted,
 * so callers send only class names and times, never portal data or secrets.
 */
export class TelegramClient {
  constructor(
    private readonly token: string,
    private readonly apiBase = "https://api.telegram.org",
  ) {}

  private async call<T>(method: string, body: object, signal?: AbortSignal): Promise<T> {
    let response;
    try {
      response = await fetch(`${this.apiBase}/bot${this.token}/${method}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: signal ?? AbortSignal.timeout(15_000),
      });
    } catch (error) {
      // undici's message can include the URL, and so the token. Keep only the kind.
      const kind = error instanceof Error ? error.name : "Error";
      throw new TelegramError(`${method} failed: ${kind}`);
    }
    const parsed = (await response.json().catch(() => ({ ok: false }))) as ApiResponse<T>;
    if (!parsed.ok || parsed.result === undefined) {
      throw new TelegramError(`${method}: ${parsed.description ?? `HTTP ${response.status}`}`, parsed.error_code);
    }
    return parsed.result;
  }

  getMe(): Promise<{ id: number; username: string }> {
    return this.call("getMe", {});
  }

  async sendMessage(chatId: string, text: string, button?: InlineButton): Promise<void> {
    await this.call("sendMessage", {
      chat_id: chatId,
      text,
      link_preview_options: { is_disabled: true },
      ...(button ? { reply_markup: { inline_keyboard: [[button]] } } : {}),
    });
  }

  /** Long polling. Only one consumer per bot may run, so only the session-worker calls this. */
  getUpdates(offset: number, timeoutSeconds: number, signal?: AbortSignal): Promise<TelegramUpdate[]> {
    return this.call(
      "getUpdates",
      { offset, timeout: timeoutSeconds, allowed_updates: ["message"] },
      signal ?? AbortSignal.timeout((timeoutSeconds + 10) * 1000),
    );
  }
}
