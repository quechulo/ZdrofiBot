import "reflect-metadata";
import { Logger } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { FireWorkerModule } from "./worker.module.js";

const app = await NestFactory.createApplicationContext(FireWorkerModule);
const logger = new Logger("fire-worker");
logger.log("Started");

await new Promise<void>((resolve) => {
  process.once("SIGTERM", resolve);
  process.once("SIGINT", resolve);
});

logger.log("Stopping");
// Hands back distant jobs and finishes those about to fire. See FireEngine.stop.
await app.close();
logger.log("Stopped");
