import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import type { AnyDatabase } from "./client.js";
import * as schema from "./schema.js";

const migrationsFolder = fileURLToPath(new URL("../migrations", import.meta.url));

/** A fresh in-memory Postgres with every migration applied. Tests only. */
export async function createTestDb(): Promise<AnyDatabase> {
  const db = drizzle(new PGlite(), { schema });
  await migrate(db, { migrationsFolder });
  return db as unknown as AnyDatabase;
}
