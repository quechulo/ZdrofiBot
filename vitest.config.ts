import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const src = (path: string) => fileURLToPath(new URL(path, import.meta.url));
const lib = (name: string) => ({ find: new RegExp(`^@zdrofibot/${name}$`), replacement: src(`./libs/${name}/src/index.ts`) });

export default defineConfig({
  resolve: {
    alias: [
      { find: /^@zdrofibot\/db\/testing$/, replacement: src("./libs/db/src/testing.ts") },
      { find: /^@zdrofibot\/mock-portal$/, replacement: src("./test/mock-portal/src/index.ts") },
      ...["crypto", "db", "portal", "scheduling", "sessions"].map(lib),
    ],
  },
  test: {
    include: ["apps/**/*.spec.ts", "libs/**/*.spec.ts", "test/**/*.spec.ts"],
  },
});
