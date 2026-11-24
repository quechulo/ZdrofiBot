import { portalAccounts, portalActivities, registrationJobs, type AnyDatabase } from "@zdrofibot/db";
import { PortalClient, type ScheduleItem } from "@zdrofibot/portal";
import { opensAt, parsePortalTime } from "@zdrofibot/scheduling";
import { and, eq, inArray, ne, sql } from "drizzle-orm";
import { describeError, type Log } from "./log.js";

export interface DiscoveryOptions {
  portalOrigin: string;
  userAgent: string;
  extraClubs: string[];
}

export interface DiscoveryResult {
  clubs: number;
  classes: number;
  movedJobs: number;
  failedClubs: string[];
}

const excluded = (column: string) => sql.raw(`excluded."${column}"`);

/**
 * Copies the public schedule into `portal_activities`. Plain HTTP with no
 * session (R7), so it costs no login and can't harm one.
 */
export class Discovery {
  private readonly client: PortalClient;

  constructor(
    private readonly db: AnyDatabase,
    private readonly options: DiscoveryOptions,
    private readonly log: Log,
  ) {
    this.client = new PortalClient({ userAgent: options.userAgent, origin: options.portalOrigin });
  }

  private async clubs(): Promise<string[]> {
    const homes = await this.db.selectDistinct({ club: portalAccounts.homeClubSlug }).from(portalAccounts);
    return [...new Set([...homes.map((row) => row.club), ...this.options.extraClubs])];
  }

  async run(now = new Date()): Promise<DiscoveryResult> {
    const result: DiscoveryResult = { clubs: 0, classes: 0, movedJobs: 0, failedClubs: [] };
    for (const club of await this.clubs()) {
      try {
        const items = await this.client.fetchSchedule(club);
        result.classes += await this.store(club, items, now);
        result.clubs++;
      } catch (error) {
        result.failedClubs.push(club);
        this.log.error(`Discovery for ${club} failed: ${describeError(error)}`);
      }
    }
    result.movedJobs = await this.followMovedOpenings(now);
    this.log.log(
      `Discovery: ${result.classes} classes in ${result.clubs} club(s)` +
        (result.movedJobs ? `, ${result.movedJobs} job(s) moved to a new opening time` : ""),
    );
    return result;
  }

  private async store(club: string, items: ScheduleItem[], now: Date): Promise<number> {
    const rows = items.flatMap((item) => {
      try {
        const startsAt = parsePortalTime(item.startsAtLocal);
        return [
          {
            id: item.id,
            clubSlug: item.clubSlug || club,
            name: item.name,
            startsAt,
            opensAt: opensAt(startsAt),
            window: item.window,
            full: item.full,
            seatsTaken: item.seatsTaken,
            seatsTotal: item.seatsTotal,
            lastSeenAt: now,
          },
        ];
      } catch {
        this.log.warn(`Discovery: skipped class ${item.id} with an unreadable time`);
        return [];
      }
    });
    if (rows.length === 0) return 0;
    await this.db
      .insert(portalActivities)
      .values(rows)
      .onConflictDoUpdate({
        target: portalActivities.id,
        set: {
          clubSlug: excluded("club_slug"),
          name: excluded("name"),
          startsAt: excluded("starts_at"),
          opensAt: excluded("opens_at"),
          window: excluded("window"),
          full: excluded("full"),
          seatsTaken: excluded("seats_taken"),
          seatsTotal: excluded("seats_total"),
          lastSeenAt: excluded("last_seen_at"),
        },
      });
    return rows.length;
  }

  /**
   * A class moved to another time moves its pending jobs with it. An armed job
   * then fails the fire worker's FIRING check, is handed back and re-armed.
   */
  private async followMovedOpenings(now: Date): Promise<number> {
    const activityOpensAt = sql`(select ${portalActivities.opensAt} from ${portalActivities} where ${portalActivities.id} = ${registrationJobs.portalActivityId})`;
    const moved = await this.db
      .update(registrationJobs)
      .set({ opensAt: sql`${activityOpensAt}`, updatedAt: now })
      .where(
        and(
          inArray(registrationJobs.state, ["SCHEDULED", "ARMED"]),
          ne(registrationJobs.opensAt, activityOpensAt),
        ),
      )
      .returning({ id: registrationJobs.id });
    return moved.length;
  }
}

/** For the CLI and tests: one class by id. */
export async function findActivity(db: AnyDatabase, id: number) {
  const [row] = await db.select().from(portalActivities).where(eq(portalActivities.id, id));
  return row ?? null;
}
