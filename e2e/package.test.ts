import { describe, expect, test } from "bun:test";

describe("package exports", () => {
  test("loads the public factory from the source condition", () => {
    const result = Bun.spawnSync([
      "bun",
      "--conditions=corbits-system-one-src",
      "-e",
      'import { createSystemOneAdapterFactory } from "@corbits/system-one"; if (!import.meta.resolve("@corbits/system-one").endsWith("/src/index.ts") || typeof createSystemOneAdapterFactory !== "function") process.exit(1);',
    ]);

    expect(result.stderr.toString()).toBe("");
    expect(result.exitCode).toBe(0);
  });
});
