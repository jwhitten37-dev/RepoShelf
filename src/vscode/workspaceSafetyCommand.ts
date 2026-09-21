import * as vscode from "vscode";
import { GitLabError } from "../domain/errors.js";
import { decideWorkspaceSafety } from "../domain/workspaceSafety.js";
import type { Logger } from "../infrastructure/logger.js";
import type { WorkspaceSafetyCollector } from "../infrastructure/workspaceSafety.js";
import { countUnsavedWorkspaceBuffers } from "./workspaceBuffers.js";
import type { LoadedWorkspaceRegistry } from "./workspaceRegistry.js";

export class WorkspaceSafetyCommand {
  public constructor(
    private readonly registry: LoadedWorkspaceRegistry,
    private readonly collector: WorkspaceSafetyCollector,
    private readonly logger: Logger,
  ) {}

  public async check(): Promise<void> {
    const folders = vscode.workspace.workspaceFolders;
    if (folders?.length !== 1) {
      await vscode.window.showWarningMessage(
        "Open exactly one RepoShelf-managed workspace before checking safety.",
      );
      return;
    }
    const folder = folders[0];
    if (folder === undefined) return;
    const record = this.registry.getByLocalPath(folder.uri.fsPath);
    if (record === undefined) {
      await vscode.window.showWarningMessage(
        "The current folder is not registered as a RepoShelf-managed workspace on this host.",
      );
      return;
    }

    try {
      const snapshot = await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: "Checking managed workspace safety…",
          cancellable: true,
        },
        async (_progress, cancellation) => {
          const controller = cancellationToAbortController(cancellation);
          return this.collector.collect(record, controller.signal);
        },
      );
      const decision = decideWorkspaceSafety({
        ownershipValid: true,
        unsavedEditorCount: countUnsavedWorkspaceBuffers(record.localPath),
        expectedBranch: record.targetBranch,
        expectedOriginUrl: record.canonicalRepositoryUrl,
        snapshot,
      });
      this.logDecision(decision.safe, decision.blockers);
      if (decision.safe) {
        await vscode.window.showInformationMessage(
          `Workspace safety check passed. ${ignoredContentSummary(snapshot.ignoredGeneratedEntryCount)} This read-only check does not release or delete the workspace.`,
        );
        return;
      }
      const choice = await vscode.window.showWarningMessage(
        `Workspace safety check blocked: ${decision.blockers.map(({ message }) => message).join(" ")}`,
        "Show Output",
      );
      if (choice === "Show Output") this.logger.show();
    } catch (error) {
      this.logger.error(
        "Workspace safety check blocked because ownership, path, or Git evidence could not be proven",
      );
      const cancelled =
        error instanceof GitLabError && error.code === "cancelled";
      if (cancelled) return;
      const choice = await vscode.window.showWarningMessage(
        "Workspace safety check blocked because complete ownership, path, and Git evidence could not be proven.",
        "Show Output",
      );
      if (choice === "Show Output") this.logger.show();
    }
  }

  private logDecision(
    safe: boolean,
    blockers: readonly { readonly code: string; readonly message: string }[],
  ): void {
    this.logger.info(
      `Workspace safety check ${safe ? "passed" : "blocked"}; blockers=${blockers.length}`,
    );
    for (const blocker of blockers) {
      this.logger.info(`Safety blocker ${blocker.code}: ${blocker.message}`);
    }
  }
}

function ignoredContentSummary(generatedEntryCount: number): string {
  return generatedEntryCount === 0
    ? "No ignored content was found."
    : `${generatedEntryCount} ignored generated item(s) will be removed if you explicitly release this workspace.`;
}

function cancellationToAbortController(
  token: vscode.CancellationToken,
): AbortController {
  const controller = new AbortController();
  if (token.isCancellationRequested) controller.abort();
  else
    token.onCancellationRequested(() => {
      controller.abort();
    });
  return controller;
}
