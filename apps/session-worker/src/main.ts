import "reflect-metadata";
import { Logger } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { SessionWorkerModule } from "./worker.module.js";

const app = await NestFactory.createApplicationContext(SessionWorkerModule);
const logger = new Logger("session-worker");
logger.log("Started");

await new Promise<void>((resolve) => {
  process.once("SIGTERM", resolve);
  process.once("SIGINT", resolve);
});

logger.log("Stopping");
await app.close();
logger.log("Stopped");
