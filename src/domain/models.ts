export interface GitLabInstance {
  readonly schemaVersion: 1;
  readonly instanceId: string;
  readonly label: string;
  readonly baseUrl: string;
  readonly enabled: boolean;
}

export interface GitLabUser {
  readonly id: number;
  readonly username: string;
  readonly name: string;
  readonly webUrl: string;
}

export interface GitLabGroup {
  readonly id: number;
  readonly name: string;
  readonly fullName: string;
  readonly fullPath: string;
  readonly parentId: number | null;
  readonly webUrl: string;
}

export interface GitLabProject {
  readonly id: number;
  readonly name: string;
  readonly pathWithNamespace: string;
  readonly namespaceId: number;
  readonly namespaceKind: string;
  readonly defaultBranch: string | null;
  readonly webUrl: string;
  readonly httpUrlToRepo: string;
}

export interface GitLabBranch {
  readonly name: string;
  readonly commitSha: string;
  readonly isDefault: boolean;
  readonly isProtected: boolean;
  readonly canPush: boolean;
}

export interface RepositoryEntry {
  readonly id: string;
  readonly name: string;
  readonly path: string;
  readonly type: "tree" | "blob";
  readonly mode: string;
}

export interface ProjectRefContext {
  readonly instanceId: string;
  readonly projectId: number;
  readonly displayRef: string;
  readonly refType: "branch";
  readonly resolvedCommitSha: string;
  readonly isProtected: boolean;
  readonly canPush: boolean;
}

export type CloneMode = "partialSparse" | "full";

export interface ManagedWorkspaceRecord {
  readonly schemaVersion: 1;
  readonly workspaceId: string;
  readonly instanceId: string;
  readonly projectId: number;
  readonly projectPath: string;
  readonly canonicalRepositoryUrl: string;
  readonly targetBranch: string;
  readonly pinnedCommitSha: string;
  readonly cloneMode: CloneMode;
  readonly sparseDirectories: readonly string[];
  readonly localPath: string;
  readonly cloneRoot: string;
  readonly revealPath: string | undefined;
  readonly createdAt: string;
  readonly lastOpenedAt: string;
}

export interface CatalogClient {
  getCurrentUser(signal?: AbortSignal): Promise<GitLabUser>;
  listTopLevelGroups(signal?: AbortSignal): Promise<readonly GitLabGroup[]>;
  listSubgroups(
    groupId: number,
    signal?: AbortSignal,
  ): Promise<readonly GitLabGroup[]>;
  listGroupProjects(
    groupId: number,
    signal?: AbortSignal,
  ): Promise<readonly GitLabProject[]>;
  listPersonalProjects(
    userId: number,
    signal?: AbortSignal,
  ): Promise<readonly GitLabProject[]>;
  searchBranches(
    projectId: number,
    search: string,
    signal?: AbortSignal,
  ): Promise<readonly GitLabBranch[]>;
  resolveBranch(
    projectId: number,
    branch: string,
    signal?: AbortSignal,
  ): Promise<GitLabBranch>;
  listRepositoryTree(
    projectId: number,
    commitSha: string,
    path: string,
    signal?: AbortSignal,
  ): Promise<readonly RepositoryEntry[]>;
  getRawFile(
    projectId: number,
    commitSha: string,
    path: string,
    signal?: AbortSignal,
  ): Promise<Uint8Array>;
}
