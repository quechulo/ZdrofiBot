import { Test } from "@nestjs/testing";
import request from "supertest";
import { afterAll, beforeAll, describe, it } from "vitest";
import type { INestApplication } from "@nestjs/common";
import { AppModule } from "./app.module.js";

describe("GET /healthz", () => {
  let app: INestApplication;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
  });

  afterAll(() => app.close());

  it("answers ok", async () => {
    await request(app.getHttpServer()).get("/healthz").expect(200, { status: "ok" });
  });
});
