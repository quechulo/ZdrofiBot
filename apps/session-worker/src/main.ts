import "reflect-metadata";
import { Logger } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { SessionWorkerModule } from "./worker.module.js";

const app = await NestFactory.createApplicationContext(SessionWorkerModule);
const logger = new Logger("session-worker");
logger.log("Started");

// A pending promise doesn't keep Node alive, and nothing else does until the
// worker's loops exist.
const keepAlive = setInterval(() => undefined, 60_000);

await new Promise<void>((resolve) => {
  process.once("SIGTERM", resolve);
  process.once("SIGINT", resolve);
});

clearInterval(keepAlive);
await app.close();
logger.log("Stopped");
