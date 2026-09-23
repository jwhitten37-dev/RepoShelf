import { describe, expect, it } from "vitest";
import { NativeGitRunner } from "../src/infrastructure/gitRunner.js";

describe("NativeGitRunner", () => {
  it("runs Git without a shell and captures output", async () => {
    const result = await new NativeGitRunner().run(["--version"]);
    expect(result.stdout).toMatch(/^git version /u);
  });

  it("honors an already-cancelled signal", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(
      new NativeGitRunner().run(["--version"], {
        signal: controller.signal,
      }),
    ).rejects.toMatchObject({ code: "cancelled" });
  });

  it("waits for a running child to exit after cancellation", async () => {
    const controller = new AbortController();
    const runner = new NativeGitRunner(process.execPath);
    const operation = runner.run(["-e", "setInterval(() => undefined, 1000)"], {
      signal: controller.signal,
    });
    setTimeout(() => {
      controller.abort();
    }, 25);

    await expect(operation).rejects.toMatchObject({ code: "cancelled" });
  });

  it("rejects output beyond the bounded capture limit", async () => {
    const runner = new NativeGitRunner(process.execPath);

    await expect(
      runner.run([
        "-e",
        "process.stdout.write('x'.repeat(2 * 1024 * 1024 + 1))",
      ]),
    ).rejects.toThrow("output exceeded");
  });

  it("fails closed when inherited Git TLS verification is disabled", async () => {
    const original = process.env.GIT_SSL_NO_VERIFY;
    process.env.GIT_SSL_NO_VERIFY = "true";
    try {
      await expect(
        new NativeGitRunner().run(["--version"]),
      ).rejects.toMatchObject({ code: "configuration" });
    } finally {
      if (original === undefined) delete process.env.GIT_SSL_NO_VERIFY;
      else process.env.GIT_SSL_NO_VERIFY = original;
    }
  });
});
