import * as vscode from "vscode";
import { NativeGitRunner } from "./infrastructure/gitRunner.js";
import { MaterializationService } from "./infrastructure/materialization.js";
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
  const workspaceRegistry = new VsCodeWorkspaceRegistry(context.globalState);
  const git = new NativeGitRunner();
  const materialization = new MaterializationService(git, workspaceRegistry);
  const workspaceSafety = new WorkspaceSafetyCommand(
    workspaceRegistry,
    new WorkspaceSafetyCollector(git),
    logger,
  );
  const catalog = new CatalogTreeProvider(instances, clients, refs, logger);
  const workspaceRelease = new WorkspaceReleaseCommand(
    workspaceRegistry,
    new WorkspaceReleaseService(
      git,
      new WorkspaceSafetyCollector(git),
      workspaceRegistry,
    ),
    refs,
    catalog,
    logger,
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
  );

  context.subscriptions.push(
    output,
    remoteFiles,
    new RemoteDocumentStatus(),
    vscode.workspace.registerFileSystemProvider("reposhelffs", remoteFiles, {
      isCaseSensitive: true,
      isReadonly: true,
    }),
    vscode.window.registerTreeDataProvider("reposhelf.catalog", catalog),
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
    vscode.commands.registerCommand("reposhelf.releaseWorkspace", () =>
      workspaceRelease.release(),
    ),
    vscode.commands.registerCommand("reposhelf.pushAndReleaseWorkspace", () =>
      workspaceRelease.pushAndRelease(),
    ),
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration("reposhelf.instances")) {
        void commands.updateContext();
        remoteFiles.clearCache();
        catalog.refresh();
      }
    }),
  );

  await commands.updateContext();
  await revealManagedSelection(workspaceRegistry, logger);
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
