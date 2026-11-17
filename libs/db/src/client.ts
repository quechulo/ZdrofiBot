import { drizzle } from "drizzle-orm/node-postgres";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import pg from "pg";
import * as schema from "./schema.js";

/** Uses Neon's direct endpoint. pg-boss can't run through the pooler. */
export function createDb(connectionString: string) {
  const pool = new pg.Pool({ connectionString });
  return { db: drizzle(pool, { schema }), pool };
}

export type Database = ReturnType<typeof createDb>["db"];

/** Any driver: node-postgres in production, PGlite in tests. */
export type AnyDatabase = PgDatabase<PgQueryResultHKT, typeof schema>;
