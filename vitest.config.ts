import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const src = (path: string) => fileURLToPath(new URL(path, import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      "@zdrofibot/portal": src("./libs/portal/src/index.ts"),
      "@zdrofibot/scheduling": src("./libs/scheduling/src/index.ts"),
      "@zdrofibot/db": src("./libs/db/src/index.ts"),
    },
  },
  test: {
    include: ["apps/**/*.spec.ts", "libs/**/*.spec.ts", "test/**/*.spec.ts"],
  },
});
