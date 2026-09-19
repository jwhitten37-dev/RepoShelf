import * as vscode from "vscode";
import { GitLabError } from "../domain/errors.js";
import type { ManagedWorkspaceRecord } from "../domain/models.js";
import type { WorkspaceSafetyBlocker } from "../domain/workspaceSafety.js";
import type { Logger } from "../infrastructure/logger.js";
import type { WorkspaceReleaseService } from "../infrastructure/workspaceRelease.js";
import type { CatalogTreeProvider } from "./catalogTree.js";
import type { RefStore } from "./refStore.js";
import { countUnsavedWorkspaceBuffers } from "./workspaceBuffers.js";
import type { VsCodeWorkspaceRegistry } from "./workspaceRegistry.js";
import type { PendingReleaseStore } from "./pendingReleaseStore.js";

export class WorkspaceReleaseCommand {
  public constructor(
    private readonly registry: VsCodeWorkspaceRegistry,
    private readonly service: WorkspaceReleaseService,
    private readonly refs: RefStore,
    private readonly catalog: CatalogTreeProvider,
    private readonly logger: Logger,
    private readonly pending: PendingReleaseStore,
  ) {}

  public release(): Promise<void> {
    return this.run(false);
  }

  public pushAndRelease(): Promise<void> {
    return this.run(true);
  }

  private async run(push: boolean): Promise<void> {
    const record = await this.currentRecord();
    if (record === undefined) return;
    try {
      const initial = await this.withProgress(
        push ? "Checking push readiness…" : "Checking release readiness…",
        (signal) =>
          push
            ? this.service.assessPush(
                record,
                countUnsavedWorkspaceBuffers(record.localPath),
                signal,
              )
            : this.service.assessRelease(
                record,
                countUnsavedWorkspaceBuffers(record.localPath),
                signal,
              ),
      );
      if (!initial.decision.safe) {
        await this.showBlocked(initial.decision.blockers);
        return;
      }
      const bytes = await this.withProgress(
        "Measuring managed workspace…",
        (signal) => this.service.measureWorkspaceBytes(record, signal),
      );
      const action = push ? "Push and Release" : "Release";
      const confirmed = await vscode.window.showWarningMessage(
        confirmationMessage(record, bytes, push),
        { modal: true },
        action,
      );
      if (confirmed !== action) return;

      const verified = push
        ? await this.withProgress(
            "Pushing and verifying remote branch…",
            (signal) =>
              this.service.push(
                record,
                countUnsavedWorkspaceBuffers(record.localPath),
                signal,
              ),
          )
        : initial;
      if (!verified.decision.safe) {
        await this.showBlocked(verified.decision.blockers);
        return;
      }
      await this.registry.save({
        ...record,
        lastVerifiedAt: verified.snapshot.capturedAt,
        ...(push ? { lastPushedCommitSha: verified.snapshot.headSha } : {}),
      });
      const capability = await this.withProgress(
        "Performing final release safety checks…",
        (signal) =>
          this.service.prepareDeletion(
            record,
            verified.snapshot.headSha,
            countUnsavedWorkspaceBuffers(record.localPath),
            signal,
          ),
      );
      await this.refs.set(
        record.instanceId,
        record.projectId,
        record.targetBranch,
      );
      void capability;
      await this.pending.create(record.workspaceId, verified.snapshot.headSha);
      try {
        await vscode.commands.executeCommand("workbench.action.closeFolder");
      } catch (error) {
        await this.pending.clear();
        throw error;
      }
    } catch (error) {
      if (error instanceof GitLabError && error.code === "cancelled") return;
      this.logger.error("Managed workspace release failed", error);
      const choice = await vscode.window.showErrorMessage(
        "Managed workspace release failed closed. Local registry metadata was retained unless deletion completed and was verified.",
        "Show Output",
      );
      if (choice === "Show Output") this.logger.show();
    }
  }

  public async resumePendingRelease(): Promise<void> {
    const intent = await this.pending.consume();
    if (intent === undefined) return;
    try {
      if ((vscode.workspace.workspaceFolders?.length ?? 0) !== 0) {
        throw new GitLabError(
          "configuration",
          "Pending release resumed with a workspace still open; deletion was not attempted.",
        );
      }
      const record = this.registry
        .list()
        .find(({ workspaceId }) => workspaceId === intent.workspaceId);
      if (record === undefined) {
        throw new GitLabError(
          "configuration",
          "The pending managed workspace is no longer registered on this host.",
        );
      }
      const capability = await this.withProgress(
        "Revalidating and releasing managed workspace…",
        (signal) =>
          this.service.prepareDeletion(
            record,
            intent.expectedHeadSha,
            countUnsavedWorkspaceBuffers(record.localPath),
            signal,
          ),
      );
      await this.service.delete(
        capability,
        countUnsavedWorkspaceBuffers(record.localPath),
      );
      this.logger.info(
        `Released managed workspace ${record.workspaceId}; remote branch was retained`,
      );
      this.catalog.refresh();
      await vscode.window.showInformationMessage(
        "Local managed workspace released. The remote branch remains available in RepoShelf.",
      );
    } catch (error) {
      this.logger.error("Pending managed workspace release failed", error);
      const choice = await vscode.window.showErrorMessage(
        "Managed workspace release failed closed after VS Code detached the folder. Local registry metadata was retained unless deletion completed and was verified.",
        "Show Output",
      );
      if (choice === "Show Output") this.logger.show();
    }
  }

  private async currentRecord(): Promise<ManagedWorkspaceRecord | undefined> {
    const folders = vscode.workspace.workspaceFolders;
    const folder = folders?.length === 1 ? folders[0] : undefined;
    if (folder === undefined) {
      await vscode.window.showWarningMessage(
        "Open exactly one RepoShelf-managed workspace before releasing it.",
      );
      return undefined;
    }
    const record = this.registry.getByLocalPath(folder.uri.fsPath);
    if (record === undefined) {
      await vscode.window.showWarningMessage(
        "The current folder is not registered as a RepoShelf-managed workspace on this host.",
      );
    }
    return record;
  }

  private async showBlocked(
    blockers: readonly WorkspaceSafetyBlocker[],
  ): Promise<void> {
    for (const blocker of blockers) {
      this.logger.info(`Release blocker ${blocker.code}: ${blocker.message}`);
    }
    const dirty = blockers.some(
      ({ code }) => code === "dirtyGit" || code === "unsavedEditors",
    );
    const actions = dirty
      ? (["Open Source Control", "Show Output"] as const)
      : (["Show Output"] as const);
    const choice = await vscode.window.showWarningMessage(
      `Workspace release blocked: ${blockers.map(({ message }) => message).join(" ")}`,
      ...actions,
    );
    if (choice === "Open Source Control") {
      await vscode.commands.executeCommand("workbench.view.scm");
    } else if (choice === "Show Output") {
      this.logger.show();
    }
  }

  private withProgress<T>(
    title: string,
    operation: (signal: AbortSignal) => Promise<T>,
  ): Thenable<T> {
    return vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title,
        cancellable: true,
      },
      async (_progress, cancellation) => {
        const controller = cancellationToAbortController(cancellation);
        return operation(controller.signal);
      },
    );
  }
}

function confirmationMessage(
  record: ManagedWorkspaceRecord,
  bytes: number,
  push: boolean,
): string {
  return [
    `${push ? "Push the committed work, verify it remotely, and release" : "Release"} this local managed workspace?`,
    `Project: ${record.projectPath}`,
    `Branch: ${record.targetBranch}`,
    `Path: ${record.localPath}`,
    `Disk usage: ${formatBytes(bytes)}`,
    "Only the local checkout will be deleted. The remote project and branch will not be deleted.",
  ].join("\n");
}

function formatBytes(bytes: number): string {
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(unit === 0 ? 0 : 1)} ${units[unit]}`;
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
