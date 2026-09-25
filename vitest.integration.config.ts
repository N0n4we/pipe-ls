import { defineConfig, mergeConfig } from "vitest/config";
import base from "./vitest.config.js";

export default mergeConfig(
  base,
  defineConfig({
    test: {
      include: ["packages/*/test/**/*.integration.ts"],
      exclude: ["packages/*/test/**/*.test.ts"],
    },
  }),
);
