import { portalActivities, registrationJobs } from "@zdrofibot/db";
import { parsePortalTime } from "@zdrofibot/scheduling";
import { eq } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";
import { addActivity, addJob, addUser, createWorld, DAY, mockClass, type TestWorld } from "../test/support.js";
import { Discovery } from "./discovery.js";

let world: TestWorld;
afterEach(() => world.portal.stop());

const discovery = (extraClubs: string[] = []) =>
  new Discovery(world.db, { ...world.portalOptions, extraClubs }, world.log);

describe("Discovery", () => {
  it("copies the public schedule for each home club, with opening times", async () => {
    world = await createWorld([
      mockClass(201, Date.now() - DAY, "2027-01-15 18:00"),
      mockClass(202, Date.now() + DAY, "2027-01-17 07:30"),
    ]);
    await addUser(world, null);

    const result = await discovery().run();

    expect(result).toMatchObject({ clubs: 1, classes: 2, failedClubs: [] });
    const rows = await world.db.select().from(portalActivities).orderBy(portalActivities.id);
    expect(rows.map((row) => [row.id, row.window, row.seatsTaken, row.seatsTotal])).toEqual([
      [201, "open", 3, 17],
      [202, "not-open", 3, 17],
    ]);
    const starts = parsePortalTime("2027-01-17 07:30");
    expect(rows[1]!.startsAt).toEqual(starts);
    expect(rows[1]!.opensAt).toEqual(new Date(starts.getTime() - 2 * DAY));
  });

  it("makes no request when there are no clubs", async () => {
    world = await createWorld();
    await discovery().run();
    expect(world.portal.requests).toHaveLength(0);
  });

  it("moves pending jobs when a class's time changes, and leaves finished ones alone", async () => {
    world = await createWorld([mockClass(202, Date.now() + DAY, "2027-01-17 07:30")]);
    const { userId } = await addUser(world, null);
    const stale = new Date("2027-01-14T06:30:00Z");
    await addActivity(world, 202, stale);
    const scheduled = await addJob(world, userId, 202, stale);
    const armed = await addJob(world, (await addUser(world, null)).userId, 202, stale, "ARMED");
    const finished = await addJob(world, (await addUser(world, null)).userId, 202, stale);
    await world.db.update(registrationJobs).set({ state: "BOOKED" }).where(eq(registrationJobs.id, finished));

    const result = await discovery().run();

    expect(result.movedJobs).toBe(2);
    const opensAt = new Date(parsePortalTime("2027-01-17 07:30").getTime() - 2 * DAY);
    const jobOpens = async (id: string) =>
      (await world.db.select().from(registrationJobs).where(eq(registrationJobs.id, id)))[0]!.opensAt;
    expect(await jobOpens(scheduled)).toEqual(opensAt);
    expect(await jobOpens(armed)).toEqual(opensAt);
    expect(await jobOpens(finished)).toEqual(stale);
  });

  it("updates seats on the next run", async () => {
    const cls = mockClass(201, Date.now() - DAY, "2027-01-15 18:00");
    world = await createWorld([cls]);
    await addUser(world, null);
    await discovery().run();
    cls.seatsTaken = 17;

    await discovery().run();

    const [row] = await world.db.select().from(portalActivities);
    expect([row!.seatsTaken, row!.full]).toEqual([17, true]);
  });
});
