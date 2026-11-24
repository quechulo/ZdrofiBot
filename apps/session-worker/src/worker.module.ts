import { Logger, Module } from "@nestjs/common";
import { createDb } from "@zdrofibot/db";
import { PgBoss } from "pg-boss";
import { loadConfig, type SessionWorkerConfig } from "./config.js";
import { buildServices } from "./services.js";
import { SessionWorker } from "./session-worker.js";

const CONFIG = Symbol("CONFIG");
const DATABASE = Symbol("DATABASE");

type Database = ReturnType<typeof createDb>;

// Factory providers with explicit tokens, so the tasks stay plain classes that
// tests build without Nest. Nest still calls their lifecycle hooks.
@Module({
  providers: [
    { provide: CONFIG, useFactory: () => loadConfig(process.env) },
    {
      provide: DATABASE,
      inject: [CONFIG],
      useFactory: (config: SessionWorkerConfig) => {
        const database = createDb(config.databaseUrl);
        // Runs after the worker's beforeApplicationShutdown.
        return Object.assign(database, { onApplicationShutdown: () => database.pool.end() });
      },
    },
    {
      provide: SessionWorker,
      inject: [CONFIG, DATABASE],
      useFactory: (config: SessionWorkerConfig, { db }: Database) => {
        const log = new Logger("session");
        const services = buildServices(db, config, log);
        if (!services.telegram) log.warn("TELEGRAM_BOT_TOKEN is not set, so alerts are only logged");
        // pg-boss needs Neon's direct endpoint, not the pooler.
        const boss = new PgBoss({ connectionString: config.databaseUrl, application_name: "session-worker" });
        return new SessionWorker(
          boss,
          [
            { name: "discovery", cron: "7 * * * *", run: () => services.discovery.run(), onBoot: true },
            { name: "keep-alive", cron: "*/20 * * * *", run: () => services.keepAlive.run(), onBoot: true },
            { name: "alert-ladder", cron: "* * * * *", run: () => services.ladder.run() },
            { name: "retention", cron: "30 3 * * *", run: () => services.retention.run() },
          ],
          services.linker,
          log,
        );
      },
    },
  ],
})
export class SessionWorkerModule {}
