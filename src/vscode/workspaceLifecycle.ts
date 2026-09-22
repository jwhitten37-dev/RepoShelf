import * as vscode from "vscode";
import type { ManagedWorkspaceRecord } from "../domain/models.js";
import type { ProjectedOperation } from "../infrastructure/coordinationProjection.js";
import type { Logger } from "../infrastructure/logger.js";
import type { MaterializationService } from "../infrastructure/materialization.js";
import type { WorkspaceDiskUsage } from "../infrastructure/workspaceRelease.js";
import type { LoadedWorkspaceRegistry } from "./workspaceRegistry.js";
import {
  diskUsageLabel,
  formatBytes,
  type DiskUsagePresentation,
} from "./formatBytes.js";
import {
  projectWorkspaceDashboard,
  projectWorkspaceRecommendation,
  type WorkspaceSort,
} from "./workspaceDashboardProjection.js";
import {
  projectWorkspaceLifecycles,
  type WorkspaceLifecycleItem,
  type WorkspaceLifecycleState,
} from "./workspaceLifecycleProjection.js";

export type WorkspaceLifecycleNode =
  | { readonly type: "workspace"; readonly item: WorkspaceLifecycleItem }
  | {
      readonly type: "summary";
      readonly label: string;
      readonly warning: boolean;
    }
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

export interface WorkspaceDiskUsageProvider {
  measureWorkspaceDiskUsage(
    record: ManagedWorkspaceRecord,
    signal?: AbortSignal,
  ): Promise<WorkspaceDiskUsage>;
}

const DASHBOARD_SORT_KEY = "reposhelf.workspaceDashboard.sort.v1";
const DASHBOARD_FILTER_KEY = "reposhelf.workspaceDashboard.filter.v1";
const DEFAULT_WARNING_BYTES = 2 * 1024 * 1024 * 1024;
const DEFAULT_INACTIVE_DAYS = 30;

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
  private readonly diskUsage = new Map<string, DiskUsagePresentation>();
  private measurement: AbortController | undefined;
  private readonly projectionSubscription: vscode.Disposable | undefined;

  public readonly onDidChangeTreeData = this.changed.event;

  public constructor(
    private readonly registry: LoadedWorkspaceRegistry,
    private readonly materialization: MaterializationService,
    private readonly extensionSourceRoot: string,
    private readonly logger: Logger,
    private readonly projection?: WorkspaceOperationProjection,
    private readonly diskUsageProvider?: WorkspaceDiskUsageProvider,
    private readonly dashboardState?: vscode.Memento,
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
    this.measurement?.abort();
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
    this.measureDiskUsage();
  }

  public getTreeItem(node: WorkspaceLifecycleNode): vscode.TreeItem {
    if (node.type === "summary") {
      const item = new vscode.TreeItem(
        node.label,
        vscode.TreeItemCollapsibleState.None,
      );
      item.iconPath = new vscode.ThemeIcon(
        node.warning ? "warning" : "database",
      );
      item.contextValue = "workspaceDashboardSummary";
      return item;
    }
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
    const disk = this.diskUsage.get(record.workspaceId);
    const item = new vscode.TreeItem(
      record.projectPath,
      vscode.TreeItemCollapsibleState.Collapsed,
    );
    item.id = record.workspaceId;
    item.description = [
      record.targetBranch,
      stateLabel(state),
      disk?.state === "unavailable" ? "Validation required" : undefined,
    ]
      .filter((value) => value !== undefined)
      .join(" · ");
    const recommendation = this.recommendation(record);
    item.tooltip = [
      `Project: ${record.projectPath}`,
      `Branch: ${record.targetBranch}`,
      `Path: ${record.localPath}`,
      `Clone mode: ${cloneModeLabel(record)}`,
      `Lifecycle: ${stateLabel(state)}`,
      `Disk usage: ${diskUsageLabel(this.diskUsage.get(record.workspaceId))}`,
      ...(recommendation === undefined
        ? []
        : [`Recommendation: ${recommendationLabel(recommendation.reasons)}`]),
    ].join("\n");
    item.iconPath = new vscode.ThemeIcon(
      disk?.state === "unavailable" ? "warning" : stateIcon(state),
    );
    item.contextValue = "managedWorkspace";
    return item;
  }

  public getChildren(node?: WorkspaceLifecycleNode): WorkspaceLifecycleNode[] {
    if (node === undefined) {
      const dashboard = this.dashboard();
      return [
        {
          type: "summary",
          label: dashboardSummary(dashboard, this.filterText()),
          warning: dashboard.exceedsWarning,
        },
        ...dashboard.items.map(({ lifecycle: item }) => ({
          type: "workspace" as const,
          item,
        })),
      ];
    }
    if (node.type === "detail" || node.type === "summary") return [];
    const { record, state, operationId, diagnosticCode } = node.item;
    const usage = this.diskUsage.get(record.workspaceId);
    const recommendation = this.recommendation(record);
    return [
      detail("Branch", record.targetBranch, "git-branch"),
      detail("Local path", record.localPath, "folder"),
      detail("Clone mode", cloneModeLabel(record), "repo-clone"),
      detail("Total disk usage", diskUsageLabel(usage), "database"),
      ...(usage?.state === "available"
        ? [
            detail(
              "Working tree",
              formatBytes(usage.usage.worktreeBytes),
              "files",
            ),
            detail(
              "Git directory",
              formatBytes(usage.usage.gitDirectoryBytes),
              "git-commit",
            ),
          ]
        : []),
      ...(usage?.state === "unavailable"
        ? [
            detail(
              "Disk validation",
              "Unavailable; refresh or inspect diagnostics",
              "warning",
            ),
          ]
        : []),
      detail("Last opened", formatTimestamp(record.lastOpenedAt), "history"),
      ...(recommendation === undefined
        ? []
        : [
            detail(
              "Recommendation",
              recommendationLabel(recommendation.reasons),
              "lightbulb",
            ),
          ]),
      detail("Lifecycle", stateLabel(state), stateIcon(state)),
      ...(operationId === undefined
        ? []
        : [detail("Operation", operationId, "history")]),
      ...(diagnosticCode === undefined
        ? []
        : [detail("Diagnostic", diagnosticCode, "warning")]),
    ];
  }

  public async selectSort(): Promise<void> {
    const options: readonly {
      readonly label: string;
      readonly description: string;
      readonly value: WorkspaceSort;
    }[] = [
      {
        label: "$(database) Disk Usage",
        description: "Largest measured workspace first",
        value: "sizeDescending",
      },
      {
        label: "$(history) Last Opened",
        description: "Most recently opened first",
        value: "lastOpenedDescending",
      },
      {
        label: "$(repo) Project / Group",
        description: "Alphabetical project path",
        value: "projectAscending",
      },
      {
        label: "$(git-branch) Branch",
        description: "Alphabetical branch",
        value: "branchAscending",
      },
      {
        label: "$(repo-clone) Clone Mode",
        description: "Full and sparse workspaces",
        value: "cloneMode",
      },
    ];
    const selected = await vscode.window.showQuickPick(options, {
      title: "Sort Local Workspaces",
      placeHolder: "Choose a dashboard sort order",
      ignoreFocusOut: true,
    });
    if (selected === undefined) return;
    await this.dashboardState?.update(DASHBOARD_SORT_KEY, selected.value);
    this.changed.fire();
  }

  public async setFilter(): Promise<void> {
    const value = await vscode.window.showInputBox({
      title: "Filter Local Workspaces",
      prompt:
        "Match project/group, branch, full/sparse, lifecycle, recommended, inactive, or large. Clear to show all.",
      value: this.filterText(),
      placeHolder: "platform feature sparse recommended",
      ignoreFocusOut: true,
    });
    if (value === undefined) return;
    await this.dashboardState?.update(DASHBOARD_FILTER_KEY, value.trim());
    this.changed.fire();
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

  private measureDiskUsage(): void {
    this.measurement?.abort();
    if (this.diskUsageProvider === undefined) return;
    const controller = new AbortController();
    this.measurement = controller;
    const records = this.items.map(({ record }) => record);
    const activeIds = new Set(records.map(({ workspaceId }) => workspaceId));
    for (const workspaceId of this.diskUsage.keys()) {
      if (!activeIds.has(workspaceId)) this.diskUsage.delete(workspaceId);
    }
    for (const record of records) {
      this.diskUsage.set(record.workspaceId, { state: "measuring" });
    }
    this.changed.fire();
    void runBounded(records, 2, async (record) => {
      try {
        const usage = await this.diskUsageProvider?.measureWorkspaceDiskUsage(
          record,
          controller.signal,
        );
        if (controller.signal.aborted || usage === undefined) return;
        this.diskUsage.set(record.workspaceId, { state: "available", usage });
      } catch (error) {
        if (controller.signal.aborted) return;
        this.diskUsage.set(record.workspaceId, { state: "unavailable" });
        this.logger.error(
          `Disk usage measurement unavailable for managed workspace ${record.workspaceId}`,
          error,
        );
      }
      this.changed.fire();
    }).catch((error: unknown) => {
      if (!controller.signal.aborted) {
        this.logger.error("Managed workspace disk usage refresh failed", error);
      }
    });
  }

  private dashboard() {
    const usage = new Map<string, WorkspaceDiskUsage | undefined>();
    for (const [workspaceId, presentation] of this.diskUsage) {
      usage.set(
        workspaceId,
        presentation.state === "available" ? presentation.usage : undefined,
      );
    }
    const configuration = vscode.workspace.getConfiguration("reposhelf.disk");
    const warningBytes = clamp(
      configuration.get<number>("warningBytes", DEFAULT_WARNING_BYTES),
      0,
      1024 ** 4,
    );
    const inactiveDays = clamp(
      configuration.get<number>("inactiveDays", DEFAULT_INACTIVE_DAYS),
      1,
      3650,
    );
    return projectWorkspaceDashboard(this.items, usage, {
      sort: this.sort(),
      filterText: this.filterText(),
      warningBytes,
      inactiveAgeMs: inactiveDays * 24 * 60 * 60 * 1000,
      now: Date.now(),
    });
  }

  private recommendation(record: ManagedWorkspaceRecord) {
    const presentation = this.diskUsage.get(record.workspaceId);
    const usage =
      presentation?.state === "available" ? presentation.usage : undefined;
    return projectWorkspaceRecommendation(record, usage, {
      ...this.dashboardConfiguration(),
      now: Date.now(),
    });
  }

  private dashboardConfiguration(): {
    readonly warningBytes: number;
    readonly inactiveAgeMs: number;
  } {
    const configuration = vscode.workspace.getConfiguration("reposhelf.disk");
    return {
      warningBytes: clamp(
        configuration.get<number>("warningBytes", DEFAULT_WARNING_BYTES),
        0,
        1024 ** 4,
      ),
      inactiveAgeMs:
        clamp(
          configuration.get<number>("inactiveDays", DEFAULT_INACTIVE_DAYS),
          1,
          3650,
        ) *
        24 *
        60 *
        60 *
        1000,
    };
  }

  private sort(): WorkspaceSort {
    const value = this.dashboardState?.get<unknown>(
      DASHBOARD_SORT_KEY,
      "sizeDescending",
    );
    return isWorkspaceSort(value) ? value : "sizeDescending";
  }

  private filterText(): string {
    const value = this.dashboardState?.get<unknown>(DASHBOARD_FILTER_KEY, "");
    return typeof value === "string" ? value.slice(0, 256) : "";
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

async function runBounded<T>(
  values: readonly T[],
  concurrency: number,
  operation: (value: T) => Promise<void>,
): Promise<void> {
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(concurrency, values.length) }, async () => {
      while (next < values.length) {
        const value = values[next];
        next += 1;
        if (value !== undefined) await operation(value);
      }
    }),
  );
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

function isWorkspaceSort(value: unknown): value is WorkspaceSort {
  return (
    value === "sizeDescending" ||
    value === "lastOpenedDescending" ||
    value === "projectAscending" ||
    value === "branchAscending" ||
    value === "cloneMode"
  );
}

function recommendationLabel(
  reasons: readonly ("inactive" | "large")[],
): string {
  return reasons
    .map((reason) =>
      reason === "inactive"
        ? "Inactive; review local workspace"
        : "Large; review disk usage",
    )
    .join(" · ");
}

function dashboardSummary(
  dashboard: ReturnType<typeof projectWorkspaceDashboard>,
  filterText: string,
): string {
  const filter = filterText === "" ? "" : ` · Filter: ${filterText}`;
  const unavailable =
    dashboard.unavailableCount === 0
      ? ""
      : ` · ${dashboard.unavailableCount} unavailable`;
  const threshold =
    dashboard.warningBytes === 0
      ? " · size warning disabled"
      : ` · warning at ${formatBytes(dashboard.warningBytes)}`;
  return `${formatBytes(dashboard.measuredBytes)} measured${threshold} · ${dashboard.items.length} shown${unavailable}${filter}`;
}

function formatTimestamp(value: string): string {
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp)
    ? new Date(timestamp).toLocaleString()
    : "Unavailable";
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
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
