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
  readonly contributes: {
    readonly commands: readonly CommandContribution[];
    readonly views: Readonly<
      Record<string, readonly { readonly id: string; readonly name: string }[]>
    >;
    readonly menus: Readonly<Record<string, readonly MenuContribution[]>>;
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
  it("registers every contributed command", () => {
    for (const contribution of manifest.contributes.commands) {
      expect(extensionSource).toContain(`"${contribution.command}"`);
    }
  });

  it("contributes the local-workspaces dashboard", () => {
    expect(manifest.contributes.views.reposhelf).toContainEqual({
      id: "reposhelf.localWorkspaces",
      name: "Local Workspaces",
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
});
