import type { CatalogNode, ProjectNode } from "./catalogTree.js";

export interface ProjectSearchSelection {
  readonly search: string;
  readonly node: ProjectNode;
}

/**
 * Root catalog nodes while a project picked from search is shown: a header
 * naming the search, then only the chosen project.
 */
export function projectSearchSelectionNodes(
  selection: ProjectSearchSelection,
): CatalogNode[] {
  return [
    {
      type: "message",
      label: `Selected from search: ${selection.search}`,
      description: "Clear the search to show all instances",
    },
    selection.node,
  ];
}
