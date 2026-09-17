import path from "node:path";
import { stat } from "node:fs/promises";
import * as vscode from "vscode";
import type { Logger } from "../infrastructure/logger.js";
import type { VsCodeWorkspaceRegistry } from "./workspaceRegistry.js";

export async function revealManagedSelection(
  registry: VsCodeWorkspaceRegistry,
  logger: Logger,
): Promise<void> {
  const folders = vscode.workspace.workspaceFolders;
  const folder = folders?.[0];
  if (folder === undefined || folders?.length !== 1) return;
  const record = registry.getByLocalPath(folder.uri.fsPath);
  if (record?.revealPath === undefined) return;
  const candidate = path.resolve(
    record.localPath,
    ...record.revealPath.split("/"),
  );
  const relative = path.relative(record.localPath, candidate);
  if (
    relative === "" ||
    relative === ".." ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative)
  ) {
    logger.error("Refused to reveal a path outside the managed workspace");
    return;
  }
  try {
    const candidateStat = await stat(candidate);
    await vscode.commands.executeCommand(
      candidateStat.isDirectory() ? "revealInExplorer" : "vscode.open",
      vscode.Uri.file(candidate),
    );
  } catch (error) {
    logger.error("Unable to reveal the materialized selection", error);
  }
}
