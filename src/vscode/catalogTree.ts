import * as vscode from "vscode";
import { toUserMessage } from "../domain/errors.js";
import type {
  BranchCreationResult,
  CatalogClient,
  GitLabBranch,
  GitLabGroup,
  GitLabInstance,
  GitLabProject,
  GitLabUser,
  ProjectRefContext,
  RepositoryEntry,
} from "../domain/models.js";
import type { Logger } from "../infrastructure/logger.js";
import type { ClientFactory } from "./clientFactory.js";
import type { InstanceService } from "./instanceService.js";
import type { RefStore } from "./refStore.js";
import type { ReleasedCatalogTarget } from "./releaseCompletion.js";

export type ProjectNode = {
  readonly type: "project";
  readonly instance: GitLabInstance;
  readonly project: GitLabProject;
};

export type RepositoryNode = {
  readonly type: "repository";
  readonly instance: GitLabInstance;
  readonly project: GitLabProject;
  readonly context: ProjectRefContext;
  readonly entry: RepositoryEntry;
};

export type CatalogNode =
  | { readonly type: "instance"; readonly instance: GitLabInstance }
  | { readonly type: "groups"; readonly instance: GitLabInstance }
  | { readonly type: "personal"; readonly instance: GitLabInstance }
  | {
      readonly type: "group";
      readonly instance: GitLabInstance;
      readonly group: GitLabGroup;
    }
  | ProjectNode
  | {
      readonly type: "ref";
      readonly projectNode: ProjectNode;
      readonly context: ProjectRefContext;
    }
  | RepositoryNode
  | {
      readonly type: "message";
      readonly label: string;
      readonly description?: string;
    };

export class CatalogTreeProvider implements vscode.TreeDataProvider<CatalogNode> {
  private readonly changed = new vscode.EventEmitter<
    CatalogNode | undefined | null | void
  >();
  private readonly clients = new Map<string, Promise<CatalogClient>>();
  private readonly users = new Map<string, Promise<GitLabUser>>();
  private readonly contexts = new Map<string, Promise<ProjectRefContext>>();
  private projectSearch:
    | {
        readonly search: string;
        readonly nodes: readonly ProjectNode[];
      }
    | undefined;

  public readonly onDidChangeTreeData = this.changed.event;

  public constructor(
    private readonly instances: InstanceService,
    private readonly clientFactory: ClientFactory,
    private readonly refs: RefStore,
    private readonly logger: Logger,
  ) {}

  public refresh(node?: CatalogNode): void {
    this.clients.clear();
    this.users.clear();
    this.contexts.clear();
    if (node === undefined) {
      this.projectSearch = undefined;
      this.setProjectSearchContext(false);
    }
    this.changed.fire(node);
  }

  public async refreshReleasedBranch(
    target: ReleasedCatalogTarget,
  ): Promise<void> {
    try {
      const instance = this.instances
        .getInstances()
        .find(({ instanceId }) => instanceId === target.instanceId);
      if (instance === undefined || !instance.enabled) {
        throw new Error(
          "The released workspace GitLab instance is unavailable.",
        );
      }
      await (
        await this.clientFactory.create(instance)
      ).resolveBranch(target.projectId, target.targetBranch);
      await this.refs.set(
        target.instanceId,
        target.projectId,
        target.targetBranch,
      );
      this.refresh();
    } catch (error) {
      this.logger.error(
        `Released branch catalog refresh failed for project ${target.projectId}`,
        error,
      );
      throw error;
    }
  }

  public async searchBranches(
    node: ProjectNode,
    search: string,
    signal?: AbortSignal,
  ): Promise<readonly GitLabBranch[]> {
    return (await this.getClient(node.instance)).searchBranches(
      node.project.id,
      search,
      signal,
    );
  }

  public async searchProjects(
    instance: GitLabInstance,
    search: string,
    signal?: AbortSignal,
  ): Promise<readonly ProjectNode[]> {
    return (
      await (await this.getClient(instance)).searchProjects(search, signal)
    ).map((project) => ({ type: "project" as const, instance, project }));
  }

  public showProjectSearch(
    search: string,
    nodes: readonly ProjectNode[],
  ): void {
    this.projectSearch = { search, nodes };
    this.setProjectSearchContext(true);
    this.changed.fire();
  }

  public clearProjectSearch(): void {
    if (this.projectSearch === undefined) return;
    this.projectSearch = undefined;
    this.setProjectSearchContext(false);
    this.changed.fire();
  }

  private setProjectSearchContext(active: boolean): void {
    void vscode.commands.executeCommand(
      "setContext",
      "reposhelf.projectSearchActive",
      active,
    );
  }

  public async selectBranch(
    node: ProjectNode,
    branchName: string,
  ): Promise<ProjectRefContext> {
    const branch = await (
      await this.getClient(node.instance)
    ).resolveBranch(node.project.id, branchName);
    const context = branchContext(node, branch);
    await this.refs.set(node.instance.instanceId, node.project.id, branch.name);
    this.contexts.set(projectKey(node), Promise.resolve(context));
    this.changed.fire(node);
    return context;
  }

  public async createBranch(
    node: ProjectNode,
    branchName: string,
    sourceCommitSha: string,
    signal?: AbortSignal,
  ): Promise<{
    readonly context: ProjectRefContext;
    readonly confirmation: BranchCreationResult["confirmation"];
  }> {
    const result = await (
      await this.getClient(node.instance)
    ).createBranch(node.project.id, branchName, sourceCommitSha, signal);
    const context = branchContext(node, result.branch);
    await this.refs.set(
      node.instance.instanceId,
      node.project.id,
      result.branch.name,
    );
    this.contexts.set(projectKey(node), Promise.resolve(context));
    this.changed.fire(node);
    return { context, confirmation: result.confirmation };
  }

  public resolveContext(node: ProjectNode): Promise<ProjectRefContext> {
    return this.getContext(node);
  }

  public getTreeItem(node: CatalogNode): vscode.TreeItem {
    switch (node.type) {
      case "instance": {
        const item = iconItem(
          node.instance.label,
          "server-environment",
          vscode.TreeItemCollapsibleState.Expanded,
        );
        item.description = new URL(node.instance.baseUrl).host;
        item.contextValue = "instance";
        item.tooltip = `${node.instance.label}\n${node.instance.baseUrl}`;
        return item;
      }
      case "groups":
        return iconItem(
          "Groups",
          "organization",
          vscode.TreeItemCollapsibleState.Collapsed,
        );
      case "personal":
        return iconItem(
          "Personal Namespace",
          "account",
          vscode.TreeItemCollapsibleState.Collapsed,
        );
      case "group": {
        const item = iconItem(
          node.group.name,
          "folder-library",
          vscode.TreeItemCollapsibleState.Collapsed,
        );
        item.description = node.group.fullPath;
        item.contextValue = "group";
        item.tooltip = node.group.fullName;
        return item;
      }
      case "project": {
        const item = iconItem(
          node.project.name,
          "repo",
          node.project.defaultBranch === null
            ? vscode.TreeItemCollapsibleState.None
            : vscode.TreeItemCollapsibleState.Collapsed,
        );
        item.description =
          this.refs.get(node.instance.instanceId, node.project.id) ??
          node.project.defaultBranch ??
          "empty repository";
        item.contextValue = "project";
        item.tooltip = node.project.pathWithNamespace;
        return item;
      }
      case "ref": {
        const item = iconItem(
          `Ref: ${node.context.displayRef}`,
          "git-branch",
          vscode.TreeItemCollapsibleState.None,
        );
        item.description = node.context.resolvedCommitSha.slice(0, 12);
        item.contextValue = "ref";
        item.tooltip = `Branch ${node.context.displayRef}\nPinned tree commit ${node.context.resolvedCommitSha}`;
        item.command = {
          command: "reposhelf.selectBranch",
          title: "Select Branch",
          arguments: [node.projectNode],
        };
        return item;
      }
      case "repository": {
        const directory = node.entry.type === "tree";
        const item = iconItem(
          node.entry.name,
          directory ? "folder" : "file",
          directory
            ? vscode.TreeItemCollapsibleState.Collapsed
            : vscode.TreeItemCollapsibleState.None,
        );
        item.contextValue = directory ? "remoteFolder" : "remoteFile";
        item.tooltip = `${node.entry.path}\n${node.context.displayRef} @ ${node.context.resolvedCommitSha.slice(0, 12)}`;
        if (!directory) {
          item.command = {
            command: "reposhelf.openRemoteFile",
            title: "Open Remote File",
            arguments: [node],
          };
        }
        return item;
      }
      case "message": {
        const item = iconItem(
          node.label,
          "info",
          vscode.TreeItemCollapsibleState.None,
        );
        if (node.description !== undefined) item.description = node.description;
        return item;
      }
    }
  }

  public async getChildren(node?: CatalogNode): Promise<CatalogNode[]> {
    try {
      if (node === undefined) {
        if (this.projectSearch !== undefined) {
          return [
            {
              type: "message",
              label: `Project search: ${this.projectSearch.search}`,
              description: `${this.projectSearch.nodes.length} result${this.projectSearch.nodes.length === 1 ? "" : "s"}`,
            },
            ...this.projectSearch.nodes,
          ];
        }
        return this.instances
          .getEnabledInstances()
          .map((instance) => ({ type: "instance" as const, instance }));
      }
      switch (node.type) {
        case "instance":
          return [
            { type: "groups", instance: node.instance },
            { type: "personal", instance: node.instance },
          ];
        case "groups":
          return this.loadTopLevelGroups(node.instance);
        case "personal":
          return this.loadPersonalProjects(node.instance);
        case "group":
          return this.loadGroupChildren(node.instance, node.group);
        case "project":
          return this.loadProject(node);
        case "repository":
          return node.entry.type === "tree"
            ? this.loadRepositoryPath(node)
            : [];
        case "ref":
        case "message":
          return [];
      }
    } catch (error) {
      this.logger.error("Failed to load the GitLab catalog", error);
      return [
        {
          type: "message",
          label: "Unable to load remote content",
          description: toUserMessage(error),
        },
      ];
    }
  }

  private async loadTopLevelGroups(
    instance: GitLabInstance,
  ): Promise<CatalogNode[]> {
    const groups = await (await this.getClient(instance)).listTopLevelGroups();
    return groups.length === 0
      ? [{ type: "message", label: "No accessible top-level groups" }]
      : groups.map((group) => ({ type: "group" as const, instance, group }));
  }

  private async loadPersonalProjects(
    instance: GitLabInstance,
  ): Promise<CatalogNode[]> {
    const client = await this.getClient(instance);
    const user = await this.getUser(instance, client);
    const projects = await client.listPersonalProjects(user.id);
    return projects.length === 0
      ? [{ type: "message", label: "No personal projects" }]
      : projects.map((project) => ({
          type: "project" as const,
          instance,
          project,
        }));
  }

  private async loadGroupChildren(
    instance: GitLabInstance,
    group: GitLabGroup,
  ): Promise<CatalogNode[]> {
    const client = await this.getClient(instance);
    const [subgroups, projects] = await Promise.all([
      client.listSubgroups(group.id),
      client.listGroupProjects(group.id),
    ]);
    const nodes: CatalogNode[] = [
      ...subgroups.map((subgroup) => ({
        type: "group" as const,
        instance,
        group: subgroup,
      })),
      ...projects.map((project) => ({
        type: "project" as const,
        instance,
        project,
      })),
    ];
    return nodes.length === 0
      ? [{ type: "message", label: "No direct subgroups or projects" }]
      : nodes;
  }

  private async loadProject(node: ProjectNode): Promise<CatalogNode[]> {
    if (node.project.defaultBranch === null) {
      return [{ type: "message", label: "Repository has no default branch" }];
    }
    const context = await this.getContext(node);
    const entries = await (
      await this.getClient(node.instance)
    ).listRepositoryTree(node.project.id, context.resolvedCommitSha, "");
    return [
      { type: "ref", projectNode: node, context },
      ...entries.map((entry) => repositoryNode(node, context, entry)),
    ];
  }

  private async loadRepositoryPath(
    node: RepositoryNode,
  ): Promise<CatalogNode[]> {
    const entries = await (
      await this.getClient(node.instance)
    ).listRepositoryTree(
      node.project.id,
      node.context.resolvedCommitSha,
      node.entry.path,
    );
    const projectNode: ProjectNode = {
      type: "project",
      instance: node.instance,
      project: node.project,
    };
    return entries.length === 0
      ? [{ type: "message", label: "Empty directory" }]
      : entries.map((entry) =>
          repositoryNode(projectNode, node.context, entry),
        );
  }

  private getContext(node: ProjectNode): Promise<ProjectRefContext> {
    const key = projectKey(node);
    let context = this.contexts.get(key);
    if (context === undefined) {
      const branchName =
        this.refs.get(node.instance.instanceId, node.project.id) ??
        node.project.defaultBranch;
      if (branchName === null)
        throw new Error("Cannot resolve a branch for an empty repository.");
      context = this.getClient(node.instance)
        .then((client) => client.resolveBranch(node.project.id, branchName))
        .then((branch) => branchContext(node, branch));
      this.contexts.set(key, context);
    }
    return context;
  }

  private getClient(instance: GitLabInstance): Promise<CatalogClient> {
    let client = this.clients.get(instance.instanceId);
    if (client === undefined) {
      client = this.clientFactory.create(instance);
      this.clients.set(instance.instanceId, client);
    }
    return client;
  }

  private getUser(
    instance: GitLabInstance,
    client: CatalogClient,
  ): Promise<GitLabUser> {
    let user = this.users.get(instance.instanceId);
    if (user === undefined) {
      user = client.getCurrentUser();
      this.users.set(instance.instanceId, user);
    }
    return user;
  }
}

function iconItem(
  label: string,
  icon: string,
  state: vscode.TreeItemCollapsibleState,
): vscode.TreeItem {
  const item = new vscode.TreeItem(label, state);
  item.iconPath = new vscode.ThemeIcon(icon);
  return item;
}

function projectKey(node: ProjectNode): string {
  return `${node.instance.instanceId}:${node.project.id}`;
}

function branchContext(
  node: ProjectNode,
  branch: GitLabBranch,
): ProjectRefContext {
  return {
    instanceId: node.instance.instanceId,
    projectId: node.project.id,
    displayRef: branch.name,
    refType: "branch",
    resolvedCommitSha: branch.commitSha,
    isProtected: branch.isProtected,
    canPush: branch.canPush,
  };
}

function repositoryNode(
  projectNode: ProjectNode,
  context: ProjectRefContext,
  entry: RepositoryEntry,
): RepositoryNode {
  return {
    type: "repository",
    instance: projectNode.instance,
    project: projectNode.project,
    context,
    entry,
  };
}
