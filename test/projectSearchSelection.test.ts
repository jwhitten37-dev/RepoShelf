import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { ProjectNode } from "../src/vscode/catalogTree.js";
import { projectSearchSelectionNodes } from "../src/vscode/projectSearchSelection.js";

const commandSource = readFileSync(
  path.join("src", "vscode", "commands.ts"),
  "utf8",
);

const selected: ProjectNode = {
  type: "project",
  instance: {
    schemaVersion: 1,
    instanceId: "d48616b2-70ca-4fe0-91ac-d97e70a0de82",
    label: "Company GitLab",
    baseUrl: "https://gitlab.example.test",
    enabled: true,
  },
  project: {
    id: 842,
    name: "cluster-bootstrap",
    pathWithNamespace: "platform/cluster-bootstrap",
    namespaceId: 7,
    namespaceKind: "group",
    defaultBranch: "main",
    webUrl: "https://gitlab.example.test/platform/cluster-bootstrap",
    httpUrlToRepo: "https://gitlab.example.test/platform/cluster-bootstrap.git",
  },
};

describe("project search selection", () => {
  it("shows a search header followed by only the chosen project", () => {
    const nodes = projectSearchSelectionNodes({
      search: "cluster",
      node: selected,
    });
    expect(nodes).toHaveLength(2);
    expect(nodes[0]).toMatchObject({
      type: "message",
      label: "Selected from search: cluster",
    });
    expect(nodes[1]).toBe(selected);
  });

  it("passes only the picked project from the search picker to the catalog", () => {
    expect(commandSource).toContain(
      "this.catalog.showProjectSearchSelection(search, selected.node)",
    );
    expect(commandSource).not.toMatch(
      /showProjectSearch\w*\([^)]*currentNodes/u,
    );
  });
});
