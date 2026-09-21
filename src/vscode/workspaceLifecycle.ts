import * as vscode from "vscode";
import type { ManagedWorkspaceRecord } from "../domain/models.js";
import type { ProjectedOperation } from "../infrastructure/coordinationProjection.js";
import type { Logger } from "../infrastructure/logger.js";
import type { MaterializationService } from "../infrastructure/materialization.js";
import type { LoadedWorkspaceRegistry } from "./workspaceRegistry.js";
import {
  projectWorkspaceLifecycles,
  type WorkspaceLifecycleItem,
  type WorkspaceLifecycleState,
} from "./workspaceLifecycleProjection.js";

export type WorkspaceLifecycleNode =
  | { readonly type: "workspace"; readonly item: WorkspaceLifecycleItem }
  | {
      readonly type: "detail";
      readonly label: string;
      readonly value: string;
      readonly icon: string;
    };

export interface WorkspaceOperationProjection {
  readonly onDidChangeOperations: vscode.Event<void>;
  projectOperations(): Promise<readonly ProjectedOperation[]>;
}

export class WorkspaceLifecycleController implements vscode.Disposable {
  private readonly changed = new vscode.EventEmitter<
    WorkspaceLifecycleNode | undefined | null | void
  >();
  private readonly status = vscode.window.createStatusBarItem(
    "reposhelf.workspaceLifecycle",
    vscode.StatusBarAlignment.Left,
    90,
  );
  private items: readonly WorkspaceLifecycleItem[] = [];
  private readonly projectionSubscription: vscode.Disposable | undefined;

  public readonly onDidChangeTreeData = this.changed.event;

  public constructor(
    private readonly registry: LoadedWorkspaceRegistry,
    private readonly materialization: MaterializationService,
    private readonly extensionSourceRoot: string,
    private readonly logger: Logger,
    private readonly projection?: WorkspaceOperationProjection,
  ) {
    this.status.command = "reposhelf.showWorkspaceLifecycleActions";
    this.status.name = "RepoShelf Workspace Lifecycle";
    this.projectionSubscription = this.projection?.onDidChangeOperations(() => {
      void this.refresh();
    });
  }

  public dispose(): void {
    this.status.dispose();
    this.changed.dispose();
    this.projectionSubscription?.dispose();
  }

  public async refresh(): Promise<void> {
    try {
      await this.registry.reload();
      const operations =
        this.projection === undefined
          ? []
          : await this.projection.projectOperations();
      this.items = projectWorkspaceLifecycles(this.registry.list(), operations);
    } catch (error) {
      this.items = this.registry.list().map((record) => ({
        record,
        state: "attentionRequired",
        diagnosticCode: "PROJECTION_UNAVAILABLE",
      }));
      this.logger.error(
        "Workspace lifecycle projection failed closed; release actions still require fresh checks",
        error,
      );
    }
    await this.updateContext();
    this.updateStatusBar();
    this.changed.fire();
  }

  public getTreeItem(node: WorkspaceLifecycleNode): vscode.TreeItem {
    if (node.type === "detail") {
      const item = new vscode.TreeItem(
        node.label,
        vscode.TreeItemCollapsibleState.None,
      );
      item.description = node.value;
      item.tooltip = `${node.label}: ${node.value}`;
      item.iconPath = new vscode.ThemeIcon(node.icon);
      return item;
    }
    const { record, state } = node.item;
    const item = new vscode.TreeItem(
      record.projectPath,
      vscode.TreeItemCollapsibleState.Collapsed,
    );
    item.id = record.workspaceId;
    item.description = `${record.targetBranch} · ${stateLabel(state)}`;
    item.tooltip = [
      `Project: ${record.projectPath}`,
      `Branch: ${record.targetBranch}`,
      `Path: ${record.localPath}`,
      `Clone mode: ${cloneModeLabel(record)}`,
      `Lifecycle: ${stateLabel(state)}`,
    ].join("\n");
    item.iconPath = new vscode.ThemeIcon(stateIcon(state));
    item.contextValue = "managedWorkspace";
    return item;
  }

  public getChildren(node?: WorkspaceLifecycleNode): WorkspaceLifecycleNode[] {
    if (node === undefined) {
      return this.items.map((item) => ({ type: "workspace", item }));
    }
    if (node.type === "detail") return [];
    const { record, state, operationId, diagnosticCode } = node.item;
    return [
      detail("Branch", record.targetBranch, "git-branch"),
      detail("Local path", record.localPath, "folder"),
      detail("Clone mode", cloneModeLabel(record), "repo-clone"),
      detail("Lifecycle", stateLabel(state), stateIcon(state)),
      ...(operationId === undefined
        ? []
        : [detail("Operation", operationId, "history")]),
      ...(diagnosticCode === undefined
        ? []
        : [detail("Diagnostic", diagnosticCode, "warning")]),
    ];
  }

  public async showActions(): Promise<void> {
    const current = this.currentItem();
    if (current === undefined) {
      await vscode.commands.executeCommand("reposhelf.localWorkspaces.focus");
      return;
    }
    const selected = await vscode.window.showQuickPick(
      [
        {
          label: "$(shield) Check Workspace Safety",
          detail: "Read-only assessment; never releases or deletes",
          command: "reposhelf.checkWorkspaceSafety",
        },
        {
          label: "$(cloud-upload) Push and Release Local Workspace",
          detail:
            "Runs the normal fresh safety checks and explicit confirmation",
          command: "reposhelf.pushAndReleaseWorkspace",
        },
        {
          label: "$(trash) Release Local Workspace",
          detail:
            "Runs the normal fresh safety checks and explicit confirmation",
          command: "reposhelf.releaseWorkspace",
        },
        {
          label: "$(list-tree) Show Local Workspaces",
          command: "reposhelf.localWorkspaces.focus",
        },
      ],
      {
        title: `RepoShelf — ${current.record.projectPath}`,
        placeHolder: `${current.record.targetBranch} · ${stateLabel(current.state)}`,
      },
    );
    if (selected !== undefined) {
      await vscode.commands.executeCommand(selected.command);
    }
  }

  public async reopen(node: unknown): Promise<void> {
    const item = this.resolveItem(node);
    if (item === undefined) return;
    const record = item.record;
    try {
      const result = await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: `Revalidating ${record.projectPath}…`,
          cancellable: true,
        },
        (_progress, cancellation) => {
          const controller = cancellationToAbortController(cancellation);
          return this.materialization.materialize({
            extensionSourceRoot: this.extensionSourceRoot,
            cloneRoot: record.cloneRoot,
            instanceId: record.instanceId,
            projectId: record.projectId,
            projectPath: record.projectPath,
            repositoryUrl: record.canonicalRepositoryUrl,
            sourceBranch: record.targetBranch,
            targetBranch: record.targetBranch,
            pinnedCommitSha: record.pinnedCommitSha,
            cloneMode: record.cloneMode,
            sparseDirectories: record.sparseDirectories,
            ...(record.revealPath === undefined
              ? {}
              : { revealPath: record.revealPath }),
            signal: controller.signal,
          });
        },
      );
      if (!result.reused) {
        throw new Error(
          "Retained workspace revalidation created a new checkout.",
        );
      }
      await vscode.commands.executeCommand(
        "vscode.openFolder",
        vscode.Uri.file(result.record.localPath),
        { forceNewWindow: true },
      );
    } catch (error) {
      this.logger.error(
        "Unable to reopen the retained managed workspace",
        error,
      );
      const choice = await vscode.window.showWarningMessage(
        "RepoShelf could not prove that the retained workspace is still the expected managed checkout. It was not opened or modified.",
        "Show Output",
      );
      if (choice === "Show Output") this.logger.show();
    }
  }

  public showDiagnostics(node: unknown): void {
    const item = this.resolveItem(node);
    if (item !== undefined) {
      this.logger.info(
        `Workspace lifecycle ${item.record.workspaceId}: state=${item.state}; operation=${item.operationId ?? "none"}; diagnostic=${item.diagnosticCode ?? "none"}`,
      );
    }
    this.logger.show();
  }

  public async runWorkspaceAction(
    node: unknown,
    command:
      | "reposhelf.checkWorkspaceSafety"
      | "reposhelf.pushAndReleaseWorkspace"
      | "reposhelf.releaseWorkspace",
  ): Promise<void> {
    const item = this.resolveItem(node);
    if (item === undefined) return;
    if (this.currentItem()?.record.workspaceId === item.record.workspaceId) {
      await vscode.commands.executeCommand(command);
      return;
    }
    const choice = await vscode.window.showInformationMessage(
      "Open this retained workspace before running its fresh safety and release checks.",
      "Reopen Workspace",
    );
    if (choice === "Reopen Workspace") await this.reopen(node);
  }

  private async updateContext(): Promise<void> {
    const current = this.currentItem();
    await Promise.all([
      vscode.commands.executeCommand(
        "setContext",
        "reposhelf.isManagedWorkspace",
        current !== undefined,
      ),
      vscode.commands.executeCommand(
        "setContext",
        "reposhelf.workspaceLifecycleState",
        current?.state ?? "none",
      ),
      vscode.commands.executeCommand(
        "setContext",
        "reposhelf.hasManagedWorkspaces",
        this.items.length > 0,
      ),
    ]);
  }

  private updateStatusBar(): void {
    const current = this.currentItem();
    if (current === undefined) {
      this.status.hide();
      return;
    }
    this.status.text = `$(repo) RepoShelf: ${stateLabel(current.state)}`;
    this.status.tooltip = `${current.record.projectPath}\n${current.record.targetBranch}\nSelect a lifecycle action`;
    this.status.show();
  }

  private currentItem(): WorkspaceLifecycleItem | undefined {
    const folders = vscode.workspace.workspaceFolders;
    if (folders?.length !== 1) return undefined;
    const record = this.registry.getByLocalPath(folders[0]?.uri.fsPath ?? "");
    return record === undefined
      ? undefined
      : this.items.find(
          (candidate) => candidate.record.workspaceId === record.workspaceId,
        );
  }

  private resolveItem(node: unknown): WorkspaceLifecycleItem | undefined {
    const workspaceId = workspaceIdFromNode(node);
    return workspaceId === undefined
      ? undefined
      : this.items.find(
          (candidate) => candidate.record.workspaceId === workspaceId,
        );
  }
}

function detail(
  label: string,
  value: string,
  icon: string,
): WorkspaceLifecycleNode {
  return { type: "detail", label, value, icon };
}

function workspaceIdFromNode(value: unknown): string | undefined {
  if (!isRecord(value) || value.type !== "workspace") return undefined;
  if (!isRecord(value.item) || !isRecord(value.item.record)) return undefined;
  return typeof value.item.record.workspaceId === "string"
    ? value.item.record.workspaceId
    : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function cloneModeLabel(record: ManagedWorkspaceRecord): string {
  return record.cloneMode === "full"
    ? "Full worktree"
    : `Partial + sparse (${record.sparseDirectories.length} director${record.sparseDirectories.length === 1 ? "y" : "ies"})`;
}

function stateLabel(state: WorkspaceLifecycleState): string {
  switch (state) {
    case "available":
      return "Local workspace";
    case "releaseRequested":
      return "Release requested";
    case "detached":
      return "Detached; awaiting release";
    case "releasing":
      return "Release in progress";
    case "blocked":
      return "Release blocked";
    case "failedRetained":
      return "Release failed; retained";
    case "interrupted":
      return "Release interrupted; retained";
    case "attentionRequired":
      return "Attention required";
  }
}

function stateIcon(state: WorkspaceLifecycleState): string {
  switch (state) {
    case "available":
      return "repo";
    case "releaseRequested":
    case "detached":
      return "clock";
    case "releasing":
      return "sync~spin";
    case "blocked":
    case "failedRetained":
    case "interrupted":
    case "attentionRequired":
      return "warning";
  }
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
