import path from "node:path";
import * as vscode from "vscode";
import { GitLabError, toUserMessage } from "../domain/errors.js";
import {
  createRemoteFilePath,
  createRemoteFileQuery,
  parseRemoteFileIdentity,
} from "../domain/remoteUri.js";
import type { Logger } from "../infrastructure/logger.js";
import type { MaterializationService } from "../infrastructure/materialization.js";
import type { GitLabBranch, ManagedWorkspaceRecord } from "../domain/models.js";
import type { TokenStore } from "../infrastructure/secretStore.js";
import type {
  CatalogNode,
  CatalogTreeProvider,
  ProjectNode,
  RepositoryNode,
} from "./catalogTree.js";
import type { ClientFactory } from "./clientFactory.js";
import type { InstanceService } from "./instanceService.js";

const SEARCH_DEBOUNCE_MS = 300;

interface ProjectSearchItem extends vscode.QuickPickItem {
  readonly itemType: "project";
  readonly node: ProjectNode;
}

interface BranchSearchItem extends vscode.QuickPickItem {
  readonly itemType: "branch";
  readonly branch: GitLabBranch;
}

interface SearchMessageItem extends vscode.QuickPickItem {
  readonly itemType: "message";
}

type ProjectPickerItem = ProjectSearchItem | SearchMessageItem;
type BranchPickerItem = BranchSearchItem | SearchMessageItem;

export class CommandController {
  public constructor(
    private readonly instances: InstanceService,
    private readonly tokens: TokenStore,
    private readonly clients: ClientFactory,
    private readonly catalog: CatalogTreeProvider,
    private readonly logger: Logger,
    private readonly materialization: MaterializationService,
    private readonly extensionSourceRoot: string,
    private readonly beforeOpenManagedWorkspace?: (
      record: ManagedWorkspaceRecord,
    ) => Promise<void>,
  ) {}

  public async addInstance(): Promise<void> {
    try {
      if (this.instances.getInstances().length > 0) {
        await vscode.window.showInformationMessage(
          "Phase 1 supports one configured GitLab instance.",
        );
        return;
      }
      const baseUrl = await vscode.window.showInputBox({
        title: "Add GitLab Instance",
        prompt: "Corporate GitLab base URL",
        placeHolder: "https://gitlab.company.example",
        ignoreFocusOut: true,
      });
      if (baseUrl === undefined) return;

      const label = await vscode.window.showInputBox({
        title: "Add GitLab Instance",
        prompt: "Display label",
        value: new URL(baseUrl).hostname,
        ignoreFocusOut: true,
      });
      if (label === undefined) return;

      const token = await vscode.window.showInputBox({
        title: "Add GitLab Instance",
        prompt: "Personal access token (stored in VS Code SecretStorage)",
        password: true,
        ignoreFocusOut: true,
        validateInput: (value) =>
          value.trim() === ""
            ? "A personal access token is required."
            : undefined,
      });
      if (token === undefined) return;

      const instance = this.instances.create(label, baseUrl);
      const user = await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: "Testing GitLab connection…",
          cancellable: true,
        },
        async (_progress, cancellation) => {
          const controller = cancellationToAbortController(cancellation);
          return this.clients
            .createWithToken(instance, token)
            .getCurrentUser(controller.signal);
        },
      );

      await this.tokens.set(instance.instanceId, token);
      try {
        await this.instances.save(instance);
      } catch (error) {
        await this.tokens.delete(instance.instanceId);
        throw error;
      }
      await this.updateContext(true);
      this.catalog.refresh();
      this.logger.info(
        `Configured GitLab instance ${instance.label} (${instance.instanceId})`,
      );
      await vscode.window.showInformationMessage(
        `Connected to ${instance.label} as ${user.name} (@${user.username}).`,
      );
    } catch (error) {
      this.report("Unable to add the GitLab instance", error);
    }
  }

  public async testConnection(): Promise<void> {
    const instance = this.instances.getEnabledInstance();
    if (instance === undefined) {
      await vscode.window.showWarningMessage("Add a GitLab instance first.");
      return;
    }
    try {
      const user = await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: `Testing ${instance.label}…`,
          cancellable: true,
        },
        async (_progress, cancellation) => {
          const controller = cancellationToAbortController(cancellation);
          return (await this.clients.create(instance)).getCurrentUser(
            controller.signal,
          );
        },
      );
      await vscode.window.showInformationMessage(
        `Connected to ${instance.label} as ${user.name} (@${user.username}).`,
      );
    } catch (error) {
      this.report("GitLab connection test failed", error);
    }
  }

  public refresh(node?: CatalogNode): void {
    this.catalog.refresh(node);
    this.logger.info(
      "Remote catalog cache cleared; expanded nodes will reload from GitLab.",
    );
    void vscode.window.setStatusBarMessage(
      "$(refresh) GitLab catalog refreshed; expand nodes to reload them.",
      3000,
    );
  }

  public async searchProjects(): Promise<void> {
    if (this.instances.getEnabledInstance() === undefined) {
      await vscode.window.showWarningMessage("Add a GitLab instance first.");
      return;
    }
    const picker = vscode.window.createQuickPick<ProjectPickerItem>();
    picker.title = "Search RepoShelf Projects";
    picker.placeholder = "Type a project or namespace name";
    picker.matchOnDescription = true;
    picker.matchOnDetail = true;
    picker.ignoreFocusOut = true;
    picker.items = [
      searchMessage("Type at least two characters to search GitLab."),
    ];

    let timer: NodeJS.Timeout | undefined;
    let controller: AbortController | undefined;
    let generation = 0;
    let currentNodes: readonly ProjectNode[] = [];
    const disposables = [
      picker.onDidChangeValue((value) => {
        generation += 1;
        const currentGeneration = generation;
        if (timer !== undefined) clearTimeout(timer);
        controller?.abort();
        controller = undefined;
        currentNodes = [];
        const search = value.trim();
        if (search.length < 2) {
          picker.busy = false;
          picker.items = [
            searchMessage("Type at least two characters to search GitLab."),
          ];
          return;
        }
        picker.busy = true;
        picker.items = [searchMessage("Searching GitLab projects…")];
        timer = setTimeout(() => {
          controller = new AbortController();
          void this.catalog
            .searchProjects(search, controller.signal)
            .then((nodes) => {
              if (currentGeneration !== generation) return;
              currentNodes = nodes;
              picker.busy = false;
              picker.items =
                nodes.length === 0
                  ? [searchMessage(`No projects matched “${search}”.`)]
                  : nodes.map(projectSearchItem);
            })
            .catch((error: unknown) => {
              if (
                currentGeneration !== generation ||
                controller?.signal.aborted
              )
                return;
              picker.busy = false;
              picker.items = [searchMessage(toUserMessage(error))];
              this.logger.error("Remote project search failed", error);
            });
        }, SEARCH_DEBOUNCE_MS);
      }),
      picker.onDidAccept(() => {
        const selected = picker.selectedItems[0];
        if (selected?.itemType !== "project" || currentNodes.length === 0)
          return;
        const search = picker.value.trim();
        this.catalog.showProjectSearch(search, currentNodes);
        picker.hide();
        void vscode.commands.executeCommand("reposhelf.catalog.focus");
      }),
      picker.onDidHide(() => {
        generation += 1;
        if (timer !== undefined) clearTimeout(timer);
        controller?.abort();
        for (const disposable of disposables) disposable.dispose();
        picker.dispose();
      }),
    ];
    picker.show();
  }

  public clearProjectSearch(): void {
    this.catalog.clearProjectSearch();
  }

  public async selectBranch(node: ProjectNode | undefined): Promise<void> {
    if (node?.type !== "project") {
      await vscode.window.showWarningMessage(
        "Select a GitLab project before choosing a branch.",
      );
      return;
    }
    const selected = await this.pickBranch(node);
    if (selected === undefined) return;
    try {
      const activeUri = vscode.window.activeTextEditor?.document.uri;
      const context = await this.catalog.selectBranch(
        node,
        selected.branch.name,
      );
      vscode.window.setStatusBarMessage(
        `$(git-branch) ${node.project.name}: ${context.displayRef} @ ${context.resolvedCommitSha.slice(0, 12)}`,
        4000,
      );
      await this.offerActiveFileTransition(node, context, activeUri);
    } catch (error) {
      this.report("Unable to select the GitLab branch", error);
    }
  }

  private pickBranch(node: ProjectNode): Promise<BranchSearchItem | undefined> {
    return new Promise((resolve) => {
      const picker = vscode.window.createQuickPick<BranchPickerItem>();
      picker.title = `Select Branch — ${node.project.name}`;
      picker.placeholder = "Type part of a branch name";
      picker.matchOnDescription = true;
      picker.ignoreFocusOut = true;
      picker.items = [
        searchMessage("Type at least one character to search GitLab."),
      ];

      let timer: NodeJS.Timeout | undefined;
      let controller: AbortController | undefined;
      let generation = 0;
      let settled = false;
      const complete = (item?: BranchSearchItem): void => {
        if (settled) return;
        settled = true;
        resolve(item);
        picker.hide();
      };
      const disposables = [
        picker.onDidChangeValue((value) => {
          generation += 1;
          const currentGeneration = generation;
          if (timer !== undefined) clearTimeout(timer);
          controller?.abort();
          controller = undefined;
          const search = value.trim();
          if (search === "") {
            picker.busy = false;
            picker.items = [
              searchMessage("Type at least one character to search GitLab."),
            ];
            return;
          }
          picker.busy = true;
          picker.items = [searchMessage("Searching GitLab branches…")];
          timer = setTimeout(() => {
            controller = new AbortController();
            void this.catalog
              .searchBranches(node, search, controller.signal)
              .then((branches) => {
                if (currentGeneration !== generation) return;
                picker.busy = false;
                picker.items =
                  branches.length === 0
                    ? [
                        searchMessage(`No branches matched “${search}”.`),
                        searchMessage(
                          "Remote branch creation is planned for Phase 6A.",
                        ),
                      ]
                    : branches.map(branchSearchItem);
              })
              .catch((error: unknown) => {
                if (
                  currentGeneration !== generation ||
                  controller?.signal.aborted
                )
                  return;
                picker.busy = false;
                picker.items = [searchMessage(toUserMessage(error))];
                this.logger.error("Remote branch search failed", error);
              });
          }, SEARCH_DEBOUNCE_MS);
        }),
        picker.onDidAccept(() => {
          const selected = picker.selectedItems[0];
          if (selected?.itemType === "branch") complete(selected);
        }),
        picker.onDidHide(() => {
          generation += 1;
          if (timer !== undefined) clearTimeout(timer);
          controller?.abort();
          for (const disposable of disposables) disposable.dispose();
          picker.dispose();
          if (!settled) {
            settled = true;
            resolve(undefined);
          }
        }),
      ];
      picker.show();
    });
  }

  public async openRemoteFile(node: RepositoryNode | undefined): Promise<void> {
    if (node?.type !== "repository" || node.entry.type !== "blob") return;
    try {
      await vscode.window.showTextDocument(remoteUri(node, node.context));
    } catch (error) {
      this.report("Unable to open the remote GitLab file", error);
    }
  }

  public async editLocally(
    node: ProjectNode | RepositoryNode | undefined,
  ): Promise<void> {
    if (node === undefined) {
      await vscode.window.showWarningMessage(
        "Select a GitLab project, folder, or file to edit locally.",
      );
      return;
    }
    try {
      const projectNode: ProjectNode =
        node.type === "project"
          ? node
          : { type: "project", instance: node.instance, project: node.project };
      const context =
        node.type === "repository"
          ? node.context
          : await this.catalog.resolveContext(projectNode);
      const selection = await this.chooseMaterialization(node);
      if (selection === undefined) return;
      const targetBranch = await this.chooseEditableBranch(context);
      if (targetBranch === undefined) return;
      const cloneRoot = await vscode.window.showInputBox({
        title: "Managed Clone Root",
        prompt:
          "Host-local folder for extension-managed checkouts. Windows and WSL use independent roots.",
        value: this.instances.getCloneRoot(),
        ignoreFocusOut: true,
        validateInput: (value) =>
          path.isAbsolute(value.trim())
            ? undefined
            : "Enter an absolute host-local path.",
      });
      if (cloneRoot === undefined) return;

      const result = await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: `Materializing ${projectNode.project.name} (${context.displayRef})…`,
          cancellable: true,
        },
        async (_progress, cancellation) => {
          const controller = cancellationToAbortController(cancellation);
          return this.materialization.materialize({
            extensionSourceRoot: this.extensionSourceRoot,
            cloneRoot: cloneRoot.trim(),
            instanceId: projectNode.instance.instanceId,
            projectId: projectNode.project.id,
            projectPath: projectNode.project.pathWithNamespace,
            repositoryUrl: projectNode.project.httpUrlToRepo,
            sourceBranch: context.displayRef,
            targetBranch,
            pinnedCommitSha: context.resolvedCommitSha,
            cloneMode: selection.cloneMode,
            sparseDirectories: selection.sparseDirectories,
            ...(selection.revealPath === undefined
              ? {}
              : { revealPath: selection.revealPath }),
            signal: controller.signal,
          });
        },
      );
      await this.instances.saveCloneRoot(cloneRoot.trim());
      this.logger.info(
        `${result.reused ? "Reusing" : "Created"} managed workspace ${result.record.workspaceId} at ${result.record.localPath}`,
      );
      if (this.beforeOpenManagedWorkspace !== undefined) {
        try {
          await this.beforeOpenManagedWorkspace(result.record);
        } catch (error) {
          this.logger.error(
            "Coordination handoff publication failed; opening with the Phase 4 lifecycle",
            error,
          );
        }
      }
      await vscode.commands.executeCommand(
        "vscode.openFolder",
        vscode.Uri.file(result.record.localPath),
        { forceNewWindow: true },
      );
    } catch (error) {
      this.report("Unable to materialize the local workspace", error);
    }
  }

  public updateContext(
    hasInstance = this.instances.getEnabledInstance() !== undefined,
  ): Thenable<unknown> {
    return vscode.commands.executeCommand(
      "setContext",
      "reposhelf.hasInstance",
      hasInstance,
    );
  }

  private report(message: string, error: unknown): void {
    this.logger.error(message, error);
    void vscode.window
      .showErrorMessage(`${message}: ${toUserMessage(error)}`, "Show Output")
      .then((choice) => {
        if (choice === "Show Output") this.logger.show();
      });
  }

  private async chooseMaterialization(
    node: ProjectNode | RepositoryNode,
  ): Promise<
    | {
        readonly cloneMode: "partialSparse" | "full";
        readonly sparseDirectories: readonly string[];
        readonly revealPath: string | undefined;
      }
    | undefined
  > {
    if (node.type === "repository") {
      const directory =
        node.entry.type === "tree"
          ? node.entry.path
          : parentRepositoryPath(node.entry.path);
      const scope = directory === "" ? "root-level files" : directory;
      const confirmation = await vscode.window.showInformationMessage(
        `Materialize ${scope} from ${node.context.displayRef} using partial clone + cone-mode sparse checkout?`,
        { modal: true },
        "Materialize",
      );
      if (confirmation !== "Materialize") return undefined;
      return {
        cloneMode: "partialSparse",
        sparseDirectories: [directory],
        revealPath: node.entry.path,
      };
    }

    const mode = await vscode.window.showQuickPick(
      [
        {
          label: "Partial + sparse checkout",
          description: "Choose one repository directory",
          value: "partialSparse" as const,
        },
        {
          label: "Full clone",
          description: "Materialize the complete selected branch",
          value: "full" as const,
        },
      ],
      {
        title: `Edit ${node.project.name} Locally`,
        placeHolder: "Choose materialization mode",
        ignoreFocusOut: true,
      },
    );
    if (mode === undefined) return undefined;
    if (mode.value === "full") {
      return {
        cloneMode: "full",
        sparseDirectories: [],
        revealPath: undefined,
      };
    }
    const directory = await vscode.window.showInputBox({
      title: `Sparse Directory — ${node.project.name}`,
      prompt:
        "Repository-relative directory. Leave empty to materialize root-level files only.",
      placeHolder: "src/service",
      ignoreFocusOut: true,
    });
    if (directory === undefined) return undefined;
    const normalized = directory.trim().replace(/^\/+|\/+$/gu, "");
    return {
      cloneMode: "partialSparse",
      sparseDirectories: [normalized],
      revealPath: normalized === "" ? undefined : normalized,
    };
  }

  private async chooseEditableBranch(context: {
    readonly displayRef: string;
    readonly isProtected: boolean;
    readonly canPush: boolean;
  }): Promise<string | undefined> {
    if (context.canPush) return context.displayRef;
    return vscode.window.showInputBox({
      title: "Create Editable Local Branch",
      prompt: `${context.displayRef} is ${context.isProtected ? "protected and " : ""}not pushable by your GitLab account. Enter a new local branch name based on this ref.`,
      placeHolder: "feature/my-change",
      ignoreFocusOut: true,
      validateInput: (value) => {
        const branch = value.trim();
        if (branch === "") return "Enter a new branch name.";
        if (branch === context.displayRef)
          return "The editable branch must have a different name.";
        if (
          branch.startsWith("-") ||
          branch.endsWith(".") ||
          branch.endsWith("/") ||
          branch.includes("..") ||
          branch.includes("@{") ||
          hasForbiddenBranchCharacter(branch)
        ) {
          return "Enter a valid Git branch name.";
        }
        return undefined;
      },
    });
  }

  private async offerActiveFileTransition(
    project: ProjectNode,
    context: {
      readonly instanceId: string;
      readonly projectId: number;
      readonly displayRef: string;
      readonly resolvedCommitSha: string;
    },
    activeUri: vscode.Uri | undefined,
  ): Promise<void> {
    if (activeUri?.scheme !== "reposhelffs") return;
    let identity;
    try {
      identity = parseRemoteFileIdentity(
        activeUri.authority,
        activeUri.path,
        activeUri.query,
      );
    } catch {
      return;
    }
    if (
      identity.instanceId !== project.instance.instanceId ||
      identity.projectId !== project.project.id ||
      identity.commitSha === context.resolvedCommitSha
    ) {
      return;
    }

    const newUri = createUri(
      context.instanceId,
      context.projectId,
      identity.path,
      context.resolvedCommitSha,
      context.displayRef,
    );
    try {
      await (
        await this.clients.create(project.instance)
      ).getRawFile(
        project.project.id,
        context.resolvedCommitSha,
        identity.path,
      );
    } catch (error) {
      if (error instanceof GitLabError && error.code === "notFound") {
        const choice = await vscode.window.showInformationMessage(
          `${identity.path} does not exist in ${context.displayRef}. The pinned ${identity.displayRef ?? "previous ref"} document remains open.`,
          "Browse New Ref",
        );
        if (choice === "Browse New Ref") {
          await vscode.commands.executeCommand("reposhelf.catalog.focus");
        }
        return;
      }
      throw error;
    }

    const choice = await vscode.window.showInformationMessage(
      `${identity.path} exists in ${context.displayRef}. The current document remains pinned to ${identity.commitSha.slice(0, 12)}.`,
      "Open New Ref",
      "Compare Refs",
      "Keep Current",
    );
    if (choice === "Open New Ref") {
      await vscode.window.showTextDocument(newUri);
    } else if (choice === "Compare Refs") {
      await vscode.commands.executeCommand(
        "vscode.diff",
        activeUri,
        newUri,
        `${identity.path}: ${identity.displayRef ?? identity.commitSha.slice(0, 12)} ↔ ${context.displayRef}`,
      );
    }
  }
}

function remoteUri(
  node: RepositoryNode,
  context: {
    readonly instanceId: string;
    readonly projectId: number;
    readonly displayRef: string;
    readonly resolvedCommitSha: string;
  },
): vscode.Uri {
  return createUri(
    node.instance.instanceId,
    node.project.id,
    node.entry.path,
    context.resolvedCommitSha,
    context.displayRef,
  );
}

function createUri(
  instanceId: string,
  projectId: number,
  path: string,
  commitSha: string,
  displayRef: string,
): vscode.Uri {
  return vscode.Uri.from({
    scheme: "reposhelffs",
    authority: instanceId,
    path: createRemoteFilePath(projectId, path),
    query: createRemoteFileQuery(commitSha, displayRef),
  });
}

function searchMessage(label: string): SearchMessageItem {
  return {
    itemType: "message",
    label: `$(info) ${label}`,
    alwaysShow: true,
  };
}

function projectSearchItem(node: ProjectNode): ProjectSearchItem {
  return {
    itemType: "project",
    label: `$(repo) ${node.project.name}`,
    description: node.project.pathWithNamespace,
    detail:
      node.project.defaultBranch === null
        ? "Empty repository"
        : `Default branch: ${node.project.defaultBranch}`,
    alwaysShow: true,
    node,
  };
}

function branchSearchItem(branch: GitLabBranch): BranchSearchItem {
  return {
    itemType: "branch",
    label: `$(git-branch) ${branch.name}`,
    description: branch.commitSha.slice(0, 12),
    detail: [
      branch.isDefault ? "default" : undefined,
      branch.isProtected ? "protected" : undefined,
    ]
      .filter((value) => value !== undefined)
      .join(" · "),
    alwaysShow: true,
    branch,
  };
}

function cancellationToAbortController(
  token: vscode.CancellationToken,
): AbortController {
  const controller = new AbortController();
  if (token.isCancellationRequested) controller.abort();
  token.onCancellationRequested(() => {
    controller.abort();
  });
  return controller;
}

function parentRepositoryPath(repositoryPath: string): string {
  const separator = repositoryPath.lastIndexOf("/");
  return separator === -1 ? "" : repositoryPath.slice(0, separator);
}

function hasForbiddenBranchCharacter(branch: string): boolean {
  const forbidden = new Set(["~", "^", ":", "?", "*", "[", "\\"]);
  return [...branch].some((character) => {
    const code = character.codePointAt(0);
    return (
      code === undefined ||
      code <= 32 ||
      code === 127 ||
      forbidden.has(character)
    );
  });
}
