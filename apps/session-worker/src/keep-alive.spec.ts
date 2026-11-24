import { sessionEnds } from "@zdrofibot/db";
import { afterEach, describe, expect, it } from "vitest";
import { addActivity, addJob, addUser, createWorld, MINUTE, type TestWorld } from "../test/support.js";
import { KeepAlive } from "./keep-alive.js";

let world: TestWorld;
afterEach(() => world.portal.stop());

const keepAlive = () => new KeepAlive(world.db, world.vault, world.portalOptions, world.log);

describe("KeepAlive", () => {
  it("records a live session as checked", async () => {
    world = await createWorld();
    const { accountId } = await addUser(world, "s1", new Date(Date.now() - 60 * MINUTE));
    const now = new Date();

    expect(await keepAlive().run(now)).toMatchObject({ alive: 1 });
    expect((await world.vault.sessionStatus(accountId))!.lastOkAt).toEqual(now);
  });

  it("records a dead session's lifetime, then stops checking it", async () => {
    world = await createWorld();
    const loggedInAt = new Date(Date.now() - 600 * MINUTE);
    const { accountId } = await addUser(world, "s1", loggedInAt);
    world.portal.endSession("s1");

    expect(await keepAlive().run()).toMatchObject({ ended: 1 });
    expect((await world.vault.sessionStatus(accountId))!.state).toBe("NEEDS_USER");
    const [end] = await world.db.select().from(sessionEnds);
    expect([end!.loggedInAt, end!.reason]).toEqual([loggedInAt, "keep-alive"]);

    const before = world.portal.requests.length;
    await keepAlive().run();
    expect(world.portal.requests).toHaveLength(before);
  });

  it("keeps a rotated cookie, so the next check sends the new one", async () => {
    world = await createWorld();
    const { accountId } = await addUser(world, "s1");
    world.portal.rotateSession("s1", "s1-rotated");

    expect(await keepAlive().run()).toMatchObject({ alive: 1 });
    expect((await world.vault.loadStorageState(accountId))!.cookies[0]!.value).toBe("s1-rotated");
    expect(await keepAlive().run()).toMatchObject({ alive: 1 });
  });

  it("leaves a session alone while one of its jobs is armed", async () => {
    world = await createWorld();
    const { userId } = await addUser(world, "s1");
    const opensAt = new Date(Date.now() + 5 * MINUTE);
    await addActivity(world, 301, opensAt);
    await addJob(world, userId, 301, opensAt, "ARMED");

    expect(await keepAlive().run()).toMatchObject({ busy: 1 });
    expect(world.portal.requests).toHaveLength(0);
  });

  it("counts an unreachable portal without ending the session", async () => {
    world = await createWorld();
    const { accountId } = await addUser(world, "s1");
    await world.portal.stop();

    expect(await keepAlive().run()).toMatchObject({ unreachable: 1 });
    expect(await world.vault.sessionStatus(accountId)).toMatchObject({ state: "ACTIVE", failureCount: 1 });
    await world.portal.start();
  });
});
