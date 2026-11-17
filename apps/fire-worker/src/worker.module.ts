import { Logger, Module } from "@nestjs/common";
import { LocalKeyWrapper, SecretBox } from "@zdrofibot/crypto";
import { createDb } from "@zdrofibot/db";
import { SessionVault } from "@zdrofibot/sessions";
import { loadConfig, type FireConfig } from "./config.js";
import { FireEngine } from "./fire-engine.js";
import { JobStore } from "./job-store.js";

const CONFIG = Symbol("CONFIG");
const DATABASE = Symbol("DATABASE");

type Database = ReturnType<typeof createDb>;

// Factory providers with explicit tokens, so the engine stays plain classes that
// tests build without Nest. Nest still calls their lifecycle hooks.
@Module({
  providers: [
    { provide: CONFIG, useFactory: () => loadConfig(process.env) },
    {
      provide: DATABASE,
      inject: [CONFIG],
      useFactory: (config: FireConfig) => {
        const database = createDb(config.databaseUrl);
        // Runs after the engine's beforeApplicationShutdown, so the drain can still write.
        return Object.assign(database, { onApplicationShutdown: () => database.pool.end() });
      },
    },
    {
      provide: FireEngine,
      inject: [CONFIG, DATABASE],
      useFactory: (config: FireConfig, { db }: Database) =>
        new FireEngine({
          store: new JobStore(db, config.workerId, config.timings.leaseMs),
          vault: new SessionVault(db, new SecretBox(new LocalKeyWrapper(config.localKek))),
          timings: config.timings,
          portalOrigin: config.portalOrigin,
          userAgent: config.userAgent,
          log: new Logger("fire"),
        }),
    },
  ],
})
export class FireWorkerModule {}
