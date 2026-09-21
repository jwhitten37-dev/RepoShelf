import * as vscode from "vscode";
import { NativeGitRunner } from "./infrastructure/gitRunner.js";
import { MaterializationService } from "./infrastructure/materialization.js";
import { AuthoritativeWorkspaceRegistry } from "./infrastructure/authoritativeWorkspaceRegistry.js";
import { WorkspaceRegistryStore } from "./infrastructure/workspaceRegistryStore.js";
import { WorkspaceReleaseService } from "./infrastructure/workspaceRelease.js";
import { WorkspaceSafetyCollector } from "./infrastructure/workspaceSafety.js";
import { OutputChannelLogger } from "./infrastructure/logger.js";
import { VsCodeTokenStore } from "./infrastructure/secretStore.js";
import {
  CatalogTreeProvider,
  type CatalogNode,
  type ProjectNode,
  type RepositoryNode,
} from "./vscode/catalogTree.js";
import { DefaultClientFactory } from "./vscode/clientFactory.js";
import { CommandController } from "./vscode/commands.js";
import { InstanceService } from "./vscode/instanceService.js";
import { RefStore } from "./vscode/refStore.js";
import {
  RemoteDocumentStatus,
  RemoteFileSystemProvider,
} from "./vscode/remoteFileSystem.js";
import { revealManagedSelection } from "./vscode/workspaceReveal.js";
import { VsCodeWorkspaceRegistry } from "./vscode/workspaceRegistry.js";
import { WorkspaceSafetyCommand } from "./vscode/workspaceSafetyCommand.js";
import { WorkspaceReleaseCommand } from "./vscode/workspaceReleaseCommand.js";
import { PendingReleaseStore } from "./vscode/pendingReleaseStore.js";
import { VsCodeCoordinationLifecycle } from "./vscode/coordinationLifecycle.js";
import {
  WorkspaceLifecycleController,
  type WorkspaceLifecycleNode,
} from "./vscode/workspaceLifecycle.js";
import { WorkspaceReminderService } from "./vscode/workspaceReminderService.js";
import { WorkspaceReminderStore } from "./vscode/workspaceReminderStore.js";

export async function activate(
  context: vscode.ExtensionContext,
): Promise<void> {
  const output = vscode.window.createOutputChannel("RepoShelf");
  const logger = new OutputChannelLogger(output);
  const instances = new InstanceService();
  const tokens = new VsCodeTokenStore(context.secrets);
  const clients = new DefaultClientFactory(tokens, () =>
    instances.getTimeoutMs(),
  );
  const refs = new RefStore(context.globalState);
  const legacyWorkspaceRegistry = new VsCodeWorkspaceRegistry(
    context.globalState,
  );
  const workspaceRegistry = await AuthoritativeWorkspaceRegistry.load(
    new WorkspaceRegistryStore(
      context.globalStorageUri.fsPath,
      legacyWorkspaceRegistry,
    ),
    legacyWorkspaceRegistry.list(),
  );
  const pendingRelease = new PendingReleaseStore(context.globalState);
  let coordination: VsCodeCoordinationLifecycle | undefined;
  try {
    coordination = await VsCodeCoordinationLifecycle.start(
      context,
      workspaceRegistry,
      pendingRelease,
      logger,
    );
    context.subscriptions.push(coordination);
  } catch (error) {
    logger.error(
      "Coordination session startup failed; retaining the Phase 4 lifecycle",
      error,
    );
  }
  const git = new NativeGitRunner();
  const releaseService = new WorkspaceReleaseService(
    git,
    new WorkspaceSafetyCollector(git),
    workspaceRegistry,
  );
  const materialization = new MaterializationService(git, workspaceRegistry);
  const workspaceLifecycle = new WorkspaceLifecycleController(
    workspaceRegistry,
    materialization,
    context.extensionUri.fsPath,
    logger,
    coordination,
  );
  const workspaceReminders = new WorkspaceReminderService(
    workspaceRegistry,
    new WorkspaceReminderStore(context.globalState),
    logger,
  );
  const workspaceSafety = new WorkspaceSafetyCommand(
    workspaceRegistry,
    new WorkspaceSafetyCollector(git),
    logger,
  );
  const catalog = new CatalogTreeProvider(instances, clients, refs, logger);
  const workspaceRelease = new WorkspaceReleaseCommand(
    workspaceRegistry,
    releaseService,
    refs,
    catalog,
    logger,
    pendingRelease,
    coordination,
  );
  const remoteFiles = new RemoteFileSystemProvider(
    instances,
    clients,
    instances.getMaxFileCacheBytes(),
    instances.getMaxTotalCacheBytes(),
  );
  const commands = new CommandController(
    instances,
    tokens,
    clients,
    catalog,
    logger,
    materialization,
    context.extensionUri.fsPath,
    coordination === undefined
      ? undefined
      : (record) => coordination.beforeOpenManagedWorkspace(record),
  );
  coordination?.enableExecution(releaseService, workspaceRegistry, () => {
    catalog.refresh();
  });

  context.subscriptions.push(
    output,
    remoteFiles,
    new RemoteDocumentStatus(),
    workspaceLifecycle,
    workspaceReminders,
    vscode.workspace.registerFileSystemProvider("reposhelffs", remoteFiles, {
      isCaseSensitive: true,
      isReadonly: true,
    }),
    vscode.window.registerTreeDataProvider("reposhelf.catalog", catalog),
    vscode.window.createTreeView("reposhelf.localWorkspaces", {
      treeDataProvider: workspaceLifecycle,
      showCollapseAll: true,
    }),
    vscode.commands.registerCommand("reposhelf.addInstance", () =>
      commands.addInstance(),
    ),
    vscode.commands.registerCommand("reposhelf.testConnection", () =>
      commands.testConnection(),
    ),
    vscode.commands.registerCommand(
      "reposhelf.refreshCatalog",
      (node?: CatalogNode) => {
        remoteFiles.clearCache();
        commands.refresh(node);
      },
    ),
    vscode.commands.registerCommand("reposhelf.selectBranch", (node: unknown) =>
      commands.selectBranch(isProjectNode(node) ? node : undefined),
    ),
    vscode.commands.registerCommand(
      "reposhelf.openRemoteFile",
      (node: unknown) =>
        commands.openRemoteFile(isRepositoryNode(node) ? node : undefined),
    ),
    vscode.commands.registerCommand("reposhelf.editLocally", (node: unknown) =>
      commands.editLocally(
        isProjectNode(node) || isRepositoryNode(node) ? node : undefined,
      ),
    ),
    vscode.commands.registerCommand("reposhelf.checkWorkspaceSafety", () =>
      workspaceSafety.check(),
    ),
    vscode.commands.registerCommand("reposhelf.releaseWorkspace", async () => {
      await workspaceRelease.release();
      await workspaceLifecycle.refresh();
    }),
    vscode.commands.registerCommand(
      "reposhelf.pushAndReleaseWorkspace",
      async () => {
        await workspaceRelease.pushAndRelease();
        await workspaceLifecycle.refresh();
      },
    ),
    vscode.commands.registerCommand(
      "reposhelf.showWorkspaceLifecycleActions",
      () => workspaceLifecycle.showActions(),
    ),
    vscode.commands.registerCommand("reposhelf.refreshLocalWorkspaces", () =>
      workspaceLifecycle.refresh(),
    ),
    vscode.commands.registerCommand(
      "reposhelf.reopenManagedWorkspace",
      (node: WorkspaceLifecycleNode) => workspaceLifecycle.reopen(node),
    ),
    vscode.commands.registerCommand(
      "reposhelf.showWorkspaceDiagnostics",
      (node: WorkspaceLifecycleNode) => {
        workspaceLifecycle.showDiagnostics(node);
      },
    ),
    vscode.commands.registerCommand(
      "reposhelf.checkManagedWorkspaceSafety",
      (node: WorkspaceLifecycleNode) =>
        workspaceLifecycle.runWorkspaceAction(
          node,
          "reposhelf.checkWorkspaceSafety",
        ),
    ),
    vscode.commands.registerCommand(
      "reposhelf.pushAndReleaseManagedWorkspace",
      (node: WorkspaceLifecycleNode) =>
        workspaceLifecycle.runWorkspaceAction(
          node,
          "reposhelf.pushAndReleaseWorkspace",
        ),
    ),
    vscode.commands.registerCommand(
      "reposhelf.releaseManagedWorkspace",
      (node: WorkspaceLifecycleNode) =>
        workspaceLifecycle.runWorkspaceAction(
          node,
          "reposhelf.releaseWorkspace",
        ),
    ),
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration("reposhelf.instances")) {
        void commands.updateContext();
        remoteFiles.clearCache();
        catalog.refresh();
      }
      if (event.affectsConfiguration("reposhelf.reminders")) {
        workspaceReminders.restart();
      }
    }),
  );

  await commands.updateContext();
  await workspaceRelease.resumePendingRelease();
  await workspaceLifecycle.refresh();
  await revealManagedSelection(workspaceRegistry, logger);
  workspaceReminders.start();
  logger.info("RepoShelf activated");
}

export function deactivate(): void {}

function isProjectNode(value: unknown): value is ProjectNode {
  return isRecord(value) && value.type === "project";
}

function isRepositoryNode(value: unknown): value is RepositoryNode {
  return isRecord(value) && value.type === "repository";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
