import { LocalKeyWrapper, SecretBox } from "@zdrofibot/crypto";
import type { AnyDatabase } from "@zdrofibot/db";
import { SessionVault } from "@zdrofibot/sessions";
import type { SessionWorkerConfig } from "./config.js";
import { Discovery } from "./discovery.js";
import { KeepAlive } from "./keep-alive.js";
import { AlertLadder } from "./ladder.js";
import type { Log } from "./log.js";
import { Retention } from "./retention.js";
import { TelegramClient } from "./telegram/client.js";
import { TelegramLinker } from "./telegram/linker.js";
import { LogNotifier, TelegramNotifier, type Notifier } from "./telegram/notifier.js";

/** Builds every task from config. Shared by the Nest module and the CLI. */
export function buildServices(db: AnyDatabase, config: SessionWorkerConfig, log: Log) {
  const vault = new SessionVault(db, new SecretBox(new LocalKeyWrapper(config.localKek)));
  const portal = { portalOrigin: config.portalOrigin, userAgent: config.userAgent };
  const telegram = config.telegramToken ? new TelegramClient(config.telegramToken, config.telegramApiBase) : null;
  const notifier: Notifier = telegram ? new TelegramNotifier(db, telegram, log) : new LogNotifier(log);
  const keepAlive = new KeepAlive(db, vault, portal, log);
  return {
    vault,
    telegram,
    keepAlive,
    discovery: new Discovery(db, { ...portal, extraClubs: config.extraClubs }, log),
    ladder: new AlertLadder(db, vault, keepAlive, notifier, { reconnectUrl: config.reconnectUrl }, log),
    retention: new Retention(db, log),
    linker: telegram ? new TelegramLinker(db, telegram, log) : null,
  };
}
