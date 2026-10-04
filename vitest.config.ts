import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@pipe-ls/core": fileURLToPath(
        new URL("./packages/core/src/index.ts", import.meta.url),
      ),
      "@pipe-ls/hosts": fileURLToPath(
        new URL("./packages/hosts/src/index.ts", import.meta.url),
      ),
      "@pipe-ls/workspace": fileURLToPath(
        new URL("./packages/workspace/src/index.ts", import.meta.url),
      ),
      "@pipe-ls/cli": fileURLToPath(
        new URL("./packages/cli/src/index.ts", import.meta.url),
      ),
    },
  },
  test: {
    environment: "node",
    include: ["packages/*/test/**/*.test.ts"],
    clearMocks: true,
  },
});
