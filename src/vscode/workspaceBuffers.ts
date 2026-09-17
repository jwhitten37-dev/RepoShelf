import path from "node:path";
import * as vscode from "vscode";

export function countUnsavedWorkspaceBuffers(workspacePath: string): number {
  const resources = new Set<string>();
  for (const document of vscode.workspace.textDocuments) {
    if (document.isDirty && isWithinWorkspace(document.uri, workspacePath)) {
      resources.add(document.uri.toString());
    }
  }
  for (const notebook of vscode.workspace.notebookDocuments) {
    if (notebook.isDirty && isWithinWorkspace(notebook.uri, workspacePath)) {
      resources.add(notebook.uri.toString());
    }
  }
  return resources.size;
}

function isWithinWorkspace(uri: vscode.Uri, workspacePath: string): boolean {
  if (uri.scheme !== "file") return false;
  const relative = path.relative(workspacePath, uri.fsPath);
  return (
    relative === "" ||
    (!relative.startsWith(`..${path.sep}`) &&
      relative !== ".." &&
      !path.isAbsolute(relative))
  );
}
