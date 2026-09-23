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
const instanceServiceSource = readFileSync(
  path.join(root, "src", "vscode", "instanceService.ts"),
  "utf8",
);
const catalogSource = readFileSync(
  path.join(root, "src", "vscode", "catalogTree.ts"),
  "utf8",
);

describe("Phase 5A search and Phase 6A branch-write contributions", () => {
  it("registers project-search commands and exposes scoped catalog actions", () => {
    const commands = manifest.contributes.commands.map(
      ({ command }) => command,
    );
    expect(commands).toContain("reposhelf.searchProjects");
    expect(commands).toContain("reposhelf.clearProjectSearch");
    expect(extensionSource).toContain('"reposhelf.searchProjects"');
    expect(extensionSource).toContain('"reposhelf.clearProjectSearch"');

    const searchTitleActions = manifest.contributes.menus["view/title"]?.filter(
      ({ command }) => command === "reposhelf.searchProjects",
    );
    expect(searchTitleActions).toEqual([]);
    expect(manifest.contributes.menus["view/title"]).toContainEqual(
      expect.objectContaining({
        command: "reposhelf.clearProjectSearch",
        when: "view == reposhelf.catalog && reposhelf.projectSearchActive == true",
      }),
    );

    expect(manifest.contributes.menus["view/item/context"]).toContainEqual(
      expect.objectContaining({
        command: "reposhelf.searchProjects",
        when: "view == reposhelf.catalog && viewItem == instance",
        group: "inline@1",
      }),
    );
  });

  it("contributes Phase 6 multi-instance add and removal actions", () => {
    const commands = manifest.contributes.commands.map(
      ({ command }) => command,
    );
    expect(commands).toContain("reposhelf.addInstance");
    expect(commands).toContain("reposhelf.removeInstance");
    expect(extensionSource).toContain('"reposhelf.removeInstance"');
    expect(commandSource).toContain("getEnabledInstances()");
    expect(commandSource).toContain(
      "Managed local workspaces will be retained",
    );
    expect(commandSource).not.toContain("Phase 1 supports one configured");
    expect(instanceServiceSource).toContain(
      "this.saveAll([...this.getInstances(), instance])",
    );
    expect(catalogSource).toContain(".getEnabledInstances()");

    const titleActions = manifest.contributes.menus["view/title"]?.filter(
      ({ command }) => command === "reposhelf.removeInstance",
    );
    expect(titleActions).toEqual([]);
    expect(manifest.contributes.menus["view/title"]).toContainEqual(
      expect.objectContaining({
        command: "reposhelf.addInstance",
        when: "view == reposhelf.catalog",
      }),
    );

    const instanceActions = manifest.contributes.menus[
      "view/item/context"
    ]?.filter(
      ({ command }) =>
        command === "reposhelf.searchProjects" ||
        command === "reposhelf.removeInstance",
    );
    expect(instanceActions).toEqual([
      expect.objectContaining({
        command: "reposhelf.searchProjects",
        when: "view == reposhelf.catalog && viewItem == instance",
        group: "inline@1",
      }),
      expect.objectContaining({
        command: "reposhelf.removeInstance",
        when: "view == reposhelf.catalog && viewItem == instance",
        group: "inline@2",
      }),
    ]);
    expect(commandSource).toContain("resolveInstanceNode(node, instances)");
  });

  it("uses persistent Quick Picks rather than the former branch input box", () => {
    expect(commandSource).toContain("createQuickPick<ProjectPickerItem>()");
    expect(commandSource).toContain("createQuickPick<BranchPickerItem>()");
    expect(commandSource).toContain('itemType: "createBranch"');
    expect(commandSource).toContain('"Create Remote Branch"');
    expect(commandSource).toContain("source.resolvedCommitSha");
    expect(commandSource).toContain("{ modal: true }");
    expect(commandSource).not.toContain(
      "title: `Select Branch — ${node.project.name}`,\n        prompt:",
    );
  });
});
