import { defineConfig } from "vitest/config";

const windowsTimeouts =
  process.platform === "win32"
    ? {
        hookTimeout: 30_000,
        testTimeout: 30_000,
      }
    : {};

export default defineConfig({
  test: windowsTimeouts,
});
