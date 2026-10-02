import { readFileSync } from "node:fs";
import path from "node:path";
import type * as vscode from "vscode";
import { describe, expect, it } from "vitest";
import type { Logger } from "../src/infrastructure/logger.js";
import { IgnoredWorkspaceSettingNotice } from "../src/vscode/ignoredSettingNotice.js";

const manifest = JSON.parse(readFileSync("package.json", "utf8")) as {
  readonly capabilities?: {
    readonly untrustedWorkspaces?: { readonly supported?: unknown };
  };
  readonly contributes: {
    readonly configuration: {
      readonly properties: Record<string, { readonly scope?: string }>;
    };
  };
};
const instanceServiceSource = readFileSync(
  path.join("src", "vscode", "instanceService.ts"),
  "utf8",
);

class MemoryMemento implements vscode.Memento {
  private readonly values = new Map<string, unknown>();

  public keys(): readonly string[] {
    return [...this.values.keys()];
  }

  public get<T>(key: string): T | undefined;
  public get<T>(key: string, defaultValue: T): T;
  public get<T>(key: string, defaultValue?: T): T | undefined {
    return this.values.has(key) ? (this.values.get(key) as T) : defaultValue;
  }

  public update(key: string, value: unknown): Thenable<void> {
    this.values.set(key, value);
    return Promise.resolve();
  }
}

class RecordingLogger implements Logger {
  public readonly lines: string[] = [];

  public info(message: string): void {
    this.lines.push(message);
  }

  public error(message: string): void {
    this.lines.push(message);
  }

  public show(): void {}
}

describe("credential- and path-selecting settings scope", () => {
  it.each(["reposhelf.instances", "reposhelf.cloneRoot"])(
    "declares %s as machine scope so workspaces cannot set it",
    (setting) => {
      expect(
        manifest.contributes.configuration.properties[setting]?.scope,
      ).toBe("machine");
    },
  );

  it("requires a trusted workspace", () => {
    expect(manifest.capabilities?.untrustedWorkspaces?.supported).toBe(false);
  });

  it("reads instances and the clone root through user-scoped inspection", () => {
    expect(instanceServiceSource).toContain(".inspect<T>(key)");
    expect(instanceServiceSource).toContain(
      "this.readUserScoped<unknown>(INSTANCES_KEY, [])",
    );
    expect(instanceServiceSource).toContain(
      "this.readUserScoped<unknown>(CLONE_ROOT_KEY, null)",
    );
    expect(instanceServiceSource).not.toMatch(
      /\.get<[^>]+>\((?:INSTANCES_KEY|CLONE_ROOT_KEY|"cloneRoot"|"instances")/u,
    );
  });
});

describe("IgnoredWorkspaceSettingNotice", () => {
  it("logs once per session and warns once per workspace for each setting", () => {
    const state = new MemoryMemento();
    const logger = new RecordingLogger();
    const warnings: string[] = [];
    const show = (message: string): Thenable<unknown> => {
      warnings.push(message);
      return Promise.resolve(undefined);
    };

    const notice = new IgnoredWorkspaceSettingNotice(state, logger, show);
    notice.report("reposhelf.instances");
    notice.report("reposhelf.instances");
    notice.report("reposhelf.cloneRoot");
    expect(logger.lines).toHaveLength(2);
    expect(warnings).toHaveLength(2);
    expect(warnings[0]).toContain("reposhelf.instances");

    const nextSession = new IgnoredWorkspaceSettingNotice(state, logger, show);
    nextSession.report("reposhelf.instances");
    expect(logger.lines).toHaveLength(3);
    expect(warnings).toHaveLength(2);
  });

  it("tolerates malformed stored state", async () => {
    const state = new MemoryMemento();
    await state.update("reposhelf.ignoredWorkspaceSettingsNotified.v1", {
      unexpected: true,
    });
    const warnings: string[] = [];
    new IgnoredWorkspaceSettingNotice(state, new RecordingLogger(), (m) => {
      warnings.push(m);
      return Promise.resolve(undefined);
    }).report("reposhelf.instances");
    expect(warnings).toHaveLength(1);
  });
});
