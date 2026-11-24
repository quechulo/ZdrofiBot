import { portalActivities, registrationJobs, telegramLinkCodes, type AnyDatabase } from "@zdrofibot/db";
import { and, lt, notExists, or, eq, isNotNull } from "drizzle-orm";
import type { Log } from "./log.js";

const DAY = 24 * 60 * 60_000;

/** Nightly: drops what nothing needs any more. Jobs and their history are kept. */
export class Retention {
  constructor(
    private readonly db: AnyDatabase,
    private readonly log: Log,
  ) {}

  async run(now = new Date()): Promise<void> {
    const codes = await this.db
      .delete(telegramLinkCodes)
      .where(
        or(
          lt(telegramLinkCodes.expiresAt, new Date(now.getTime() - DAY)),
          and(isNotNull(telegramLinkCodes.usedAt), lt(telegramLinkCodes.usedAt, new Date(now.getTime() - DAY))),
        ),
      )
      .returning({ codeHash: telegramLinkCodes.codeHash });
    const classes = await this.db
      .delete(portalActivities)
      .where(
        and(
          lt(portalActivities.startsAt, new Date(now.getTime() - 30 * DAY)),
          notExists(
            this.db
              .select({ id: registrationJobs.id })
              .from(registrationJobs)
              .where(eq(registrationJobs.portalActivityId, portalActivities.id)),
          ),
        ),
      )
      .returning({ id: portalActivities.id });
    this.log.log(`Retention: removed ${codes.length} link code(s) and ${classes.length} old class(es)`);
  }
}
