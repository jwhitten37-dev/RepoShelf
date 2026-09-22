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
const commandSource = readFileSync(
  path.join(root, "src", "vscode", "commands.ts"),
  "utf8",
);

describe("Phase 5A search contributions", () => {
  it("registers project-search commands and exposes scoped catalog actions", () => {
    const commands = manifest.contributes.commands.map(
      ({ command }) => command,
    );
    expect(commands).toContain("reposhelf.searchProjects");
    expect(commands).toContain("reposhelf.clearProjectSearch");
    expect(extensionSource).toContain('"reposhelf.searchProjects"');
    expect(extensionSource).toContain('"reposhelf.clearProjectSearch"');

    const catalogActions = manifest.contributes.menus["view/title"]?.filter(
      ({ command }) =>
        command === "reposhelf.searchProjects" ||
        command === "reposhelf.clearProjectSearch",
    );
    expect(catalogActions).toEqual([
      expect.objectContaining({
        command: "reposhelf.searchProjects",
        when: "view == reposhelf.catalog && reposhelf.hasInstance == true",
      }),
      expect.objectContaining({
        command: "reposhelf.clearProjectSearch",
        when: "view == reposhelf.catalog && reposhelf.projectSearchActive == true",
      }),
    ]);
  });

  it("uses persistent Quick Picks rather than the former branch input box", () => {
    expect(commandSource).toContain("createQuickPick<ProjectPickerItem>()");
    expect(commandSource).toContain("createQuickPick<BranchPickerItem>()");
    expect(commandSource).toContain(
      "Remote branch creation is planned for Phase 6A.",
    );
    expect(commandSource).not.toContain(
      "title: `Select Branch — ${node.project.name}`,\n        prompt:",
    );
  });
});
