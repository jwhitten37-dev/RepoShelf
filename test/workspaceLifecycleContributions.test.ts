import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

interface CommandContribution {
  readonly command: string;
}

interface MenuContribution {
  readonly command: string;
  readonly when?: string;
  readonly group?: string;
}

interface ExtensionManifest {
  readonly categories: readonly string[];
  readonly contributes: {
    readonly commands: readonly CommandContribution[];
    readonly views: Readonly<
      Record<
        string,
        readonly {
          readonly id: string;
          readonly name: string;
          readonly icon: string;
        }[]
      >
    >;
    readonly menus: Readonly<Record<string, readonly MenuContribution[]>>;
    readonly configuration: {
      readonly properties: Readonly<
        Record<
          string,
          {
            readonly default?: unknown;
            readonly minimum?: number;
            readonly maximum?: number;
            readonly description?: string;
          }
        >
      >;
    };
  };
}

const root = process.cwd();
const manifest = JSON.parse(
  readFileSync(path.join(root, "package.json"), "utf8"),
) as ExtensionManifest;
const extensionSource = readFileSync(
  path.join(root, "src", "extension.ts"),
  "utf8",
);

describe("Phase 4.1C lifecycle contributions", () => {
  it("uses current Marketplace categories", () => {
    expect(manifest.categories).toContain("SCM Providers");
    expect(manifest.categories).not.toContain("Source Control");
  });

  it("registers every contributed command", () => {
    for (const contribution of manifest.contributes.commands) {
      expect(extensionSource).toContain(`"${contribution.command}"`);
    }
  });

  it("contributes the local-workspaces dashboard", () => {
    expect(manifest.contributes.views.reposhelf).toContainEqual({
      id: "reposhelf.localWorkspaces",
      name: "Local Workspaces",
      icon: "$(repo)",
    });
    expect(manifest.contributes.views.reposhelf).toContainEqual({
      id: "reposhelf.catalog",
      name: "Remote Catalog",
      icon: "$(cloud)",
    });
    expect(extensionSource).toContain(
      'vscode.window.createTreeView("reposhelf.localWorkspaces"',
    );
  });

  it("routes SCM actions through the reviewed commands and context key", () => {
    expect(manifest.contributes.menus["scm/title"]).toEqual([
      expect.objectContaining({
        command: "reposhelf.checkWorkspaceSafety",
        when: "reposhelf.isManagedWorkspace == true",
      }),
      expect.objectContaining({
        command: "reposhelf.pushAndReleaseWorkspace",
        when: "reposhelf.isManagedWorkspace == true",
      }),
      expect.objectContaining({
        command: "reposhelf.releaseWorkspace",
        when: "reposhelf.isManagedWorkspace == true",
      }),
    ]);
    expect(
      manifest.contributes.menus.commandPalette
        ?.filter(({ command }) =>
          [
            "reposhelf.checkWorkspaceSafety",
            "reposhelf.pushAndReleaseWorkspace",
            "reposhelf.releaseWorkspace",
          ].includes(command),
        )
        .every(({ when }) => when === "reposhelf.isManagedWorkspace == true"),
    ).toBe(true);
  });

  it("scopes dashboard lifecycle actions to managed-workspace items", () => {
    const dashboard = manifest.contributes.menus["view/item/context"]?.filter(
      ({ when }) => when?.includes("view == reposhelf.localWorkspaces"),
    );
    expect(dashboard?.map(({ command }) => command)).toEqual([
      "reposhelf.reopenManagedWorkspace",
      "reposhelf.showWorkspaceDiagnostics",
      "reposhelf.checkManagedWorkspaceSafety",
      "reposhelf.pushAndReleaseManagedWorkspace",
      "reposhelf.releaseManagedWorkspace",
    ]);
    expect(
      dashboard?.every(({ when }) =>
        when?.includes("viewItem == managedWorkspace"),
      ),
    ).toBe(true);
  });

  it("contributes Phase 5B sort, filter, and bounded advisory settings", () => {
    const titleActions = manifest.contributes.menus["view/title"]?.filter(
      ({ when }) => when === "view == reposhelf.localWorkspaces",
    );
    expect(titleActions?.map(({ command }) => command)).toEqual([
      "reposhelf.refreshLocalWorkspaces",
      "reposhelf.filterLocalWorkspaces",
      "reposhelf.sortLocalWorkspaces",
    ]);
    expect(extensionSource).toContain('"reposhelf.sortLocalWorkspaces"');
    expect(extensionSource).toContain('"reposhelf.filterLocalWorkspaces"');

    const warning =
      manifest.contributes.configuration.properties[
        "reposhelf.disk.warningBytes"
      ];
    expect(warning).toMatchObject({
      default: 2_147_483_648,
      minimum: 0,
      maximum: 1_099_511_627_776,
    });
    expect(warning?.description).toContain("never causes automatic");

    const inactive =
      manifest.contributes.configuration.properties[
        "reposhelf.disk.inactiveDays"
      ];
    expect(inactive).toMatchObject({ default: 30, minimum: 1, maximum: 3650 });
    expect(inactive?.description).toContain("never cause automatic");
  });

  it("bounds Phase 6 automatic retries to idempotent GET requests", () => {
    const retries =
      manifest.contributes.configuration.properties[
        "reposhelf.api.maxGetRetries"
      ];
    expect(retries).toMatchObject({ default: 2, minimum: 0, maximum: 3 });
    expect(retries?.description).toContain("GET");
    expect(retries?.description).toContain("writes are never retried");
  });
});
