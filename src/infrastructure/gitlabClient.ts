import { GitLabError } from "../domain/errors.js";
import type {
  CatalogClient,
  GitLabBranch,
  GitLabGroup,
  GitLabProject,
  GitLabUser,
  RepositoryEntry,
} from "../domain/models.js";
import type { GitLabHttpClient, HttpResponse } from "./http.js";

const PAGE_SIZE = "100";
const MAX_PAGES = 1000;
const MAX_REMOTE_FILE_BYTES = 52_428_800;

export class RestGitLabClient implements CatalogClient {
  public constructor(private readonly http: GitLabHttpClient) {}

  public async getCurrentUser(signal?: AbortSignal): Promise<GitLabUser> {
    const response = await this.http.get("user", {}, signal);
    return parseUser(await response.json());
  }

  public async listTopLevelGroups(
    signal?: AbortSignal,
  ): Promise<readonly GitLabGroup[]> {
    const values = await this.getAllPages(
      "groups",
      {
        min_access_level: "10",
        order_by: "name",
        sort: "asc",
        top_level_only: "true",
      },
      signal,
    );
    return values.map(parseGroup);
  }

  public async listSubgroups(
    groupId: number,
    signal?: AbortSignal,
  ): Promise<readonly GitLabGroup[]> {
    const values = await this.getAllPages(
      `groups/${groupId}/subgroups`,
      { order_by: "name", sort: "asc" },
      signal,
    );
    return values.map(parseGroup);
  }

  public async listGroupProjects(
    groupId: number,
    signal?: AbortSignal,
  ): Promise<readonly GitLabProject[]> {
    const values = await this.getAllPages(
      `groups/${groupId}/projects`,
      {
        include_subgroups: "false",
        order_by: "name",
        simple: "true",
        sort: "asc",
        with_shared: "false",
      },
      signal,
    );
    return values.map(parseProject);
  }

  public async listPersonalProjects(
    userId: number,
    signal?: AbortSignal,
  ): Promise<readonly GitLabProject[]> {
    const values = await this.getAllPages(
      `users/${userId}/projects`,
      { order_by: "name", simple: "true", sort: "asc" },
      signal,
    );
    return values.map(parseProject);
  }

  public async searchBranches(
    projectId: number,
    search: string,
    signal?: AbortSignal,
  ): Promise<readonly GitLabBranch[]> {
    const query: Record<string, string> = {};
    if (search.trim() !== "") query.search = search.trim();
    const values = await this.getAllPages(
      `projects/${projectId}/repository/branches`,
      query,
      signal,
    );
    return values.map(parseBranch);
  }

  public async resolveBranch(
    projectId: number,
    branch: string,
    signal?: AbortSignal,
  ): Promise<GitLabBranch> {
    const response = await this.http.get(
      `projects/${projectId}/repository/branches/${encodeURIComponent(branch)}`,
      {},
      signal,
    );
    return parseBranch(await response.json());
  }

  public async listRepositoryTree(
    projectId: number,
    commitSha: string,
    path: string,
    signal?: AbortSignal,
  ): Promise<readonly RepositoryEntry[]> {
    const query: Record<string, string> = { ref: commitSha };
    if (path !== "") query.path = path;
    const values = await this.getAllPages(
      `projects/${projectId}/repository/tree`,
      query,
      signal,
    );
    return values.map(parseRepositoryEntry);
  }

  public async getRawFile(
    projectId: number,
    commitSha: string,
    path: string,
    signal?: AbortSignal,
  ): Promise<Uint8Array> {
    const response = await this.http.get(
      `projects/${projectId}/repository/files/${encodeURIComponent(path)}/raw`,
      { ref: commitSha },
      signal,
    );
    const declaredSize = response.headers.get("content-length");
    if (
      declaredSize !== null &&
      Number.isFinite(Number(declaredSize)) &&
      Number(declaredSize) > MAX_REMOTE_FILE_BYTES
    ) {
      throw new GitLabError(
        "invalidResponse",
        "The remote file exceeds the 50 MiB safety limit.",
      );
    }
    const bytes = await response.bytes();
    if (bytes.byteLength > MAX_REMOTE_FILE_BYTES) {
      throw new GitLabError(
        "invalidResponse",
        "The remote file exceeds the 50 MiB safety limit.",
      );
    }
    return bytes;
  }

  private async getAllPages(
    path: string,
    query: Readonly<Record<string, string>>,
    signal?: AbortSignal,
  ): Promise<readonly unknown[]> {
    let response: HttpResponse | undefined = await this.http.get(
      path,
      { ...query, per_page: PAGE_SIZE },
      signal,
    );
    const results: unknown[] = [];
    let pageCount = 0;

    while (response !== undefined) {
      pageCount += 1;
      if (pageCount > MAX_PAGES) {
        throw new GitLabError(
          "invalidResponse",
          "GitLab pagination exceeded the safety limit.",
        );
      }
      const body = await response.json();
      if (!Array.isArray(body)) {
        throw new GitLabError(
          "invalidResponse",
          "GitLab returned a non-array collection response.",
        );
      }
      const items: unknown[] = body;
      results.push(...items);
      const next = getNextLink(response.headers);
      response =
        next === undefined
          ? undefined
          : await this.http.getAbsolute(next, signal);
    }
    return results;
  }
}

export function getNextLink(headers: Headers): URL | undefined {
  const link = headers.get("link");
  if (link === null) return undefined;
  for (const part of link.split(",")) {
    const match = part.match(/^\s*<([^>]+)>\s*;\s*rel="?([^";]+)"?/u);
    if (match?.[2] === "next" && match[1] !== undefined)
      return new URL(match[1]);
  }
  return undefined;
}

function parseUser(value: unknown): GitLabUser {
  const record = requireRecord(value, "user");
  return {
    id: requireNumber(record.id, "user.id"),
    username: requireString(record.username, "user.username"),
    name: requireString(record.name, "user.name"),
    webUrl: requireString(record.web_url, "user.web_url"),
  };
}

function parseGroup(value: unknown): GitLabGroup {
  const record = requireRecord(value, "group");
  return {
    id: requireNumber(record.id, "group.id"),
    name: requireString(record.name, "group.name"),
    fullName: requireString(record.full_name, "group.full_name"),
    fullPath: requireString(record.full_path, "group.full_path"),
    parentId:
      record.parent_id === null
        ? null
        : requireNumber(record.parent_id, "group.parent_id"),
    webUrl: requireString(record.web_url, "group.web_url"),
  };
}

function parseProject(value: unknown): GitLabProject {
  const record = requireRecord(value, "project");
  const namespace = requireRecord(record.namespace, "project.namespace");
  return {
    id: requireNumber(record.id, "project.id"),
    name: requireString(record.name, "project.name"),
    pathWithNamespace: requireString(
      record.path_with_namespace,
      "project.path_with_namespace",
    ),
    namespaceId: requireNumber(namespace.id, "project.namespace.id"),
    namespaceKind: requireString(namespace.kind, "project.namespace.kind"),
    defaultBranch:
      record.default_branch === null
        ? null
        : requireString(record.default_branch, "project.default_branch"),
    webUrl: requireString(record.web_url, "project.web_url"),
    httpUrlToRepo: requireString(
      record.http_url_to_repo,
      "project.http_url_to_repo",
    ),
  };
}

function parseBranch(value: unknown): GitLabBranch {
  const record = requireRecord(value, "branch");
  const commit = requireRecord(record.commit, "branch.commit");
  return {
    name: requireString(record.name, "branch.name"),
    commitSha: requireFullSha(commit.id, "branch.commit.id"),
    isDefault: requireBoolean(record.default, "branch.default"),
    isProtected: requireBoolean(record.protected, "branch.protected"),
    canPush: requireBoolean(record.can_push, "branch.can_push"),
  };
}

function parseRepositoryEntry(value: unknown): RepositoryEntry {
  const record = requireRecord(value, "repository entry");
  const type = requireString(record.type, "repository entry.type");
  if (type !== "tree" && type !== "blob") {
    throw new GitLabError(
      "invalidResponse",
      "GitLab returned an unsupported repository entry type.",
    );
  }
  return {
    id: requireString(record.id, "repository entry.id"),
    name: requireString(record.name, "repository entry.name"),
    path: requireString(record.path, "repository entry.path"),
    type,
    mode: requireString(record.mode, "repository entry.mode"),
  };
}

function requireRecord(value: unknown, field: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new GitLabError(
      "invalidResponse",
      `GitLab returned an invalid ${field} field.`,
    );
  }
  return value as Record<string, unknown>;
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== "string")
    throw new GitLabError(
      "invalidResponse",
      `GitLab returned an invalid ${field} field.`,
    );
  return value;
}

function requireNumber(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value)) {
    throw new GitLabError(
      "invalidResponse",
      `GitLab returned an invalid ${field} field.`,
    );
  }
  return value;
}

function requireBoolean(value: unknown, field: string): boolean {
  if (typeof value !== "boolean") {
    throw new GitLabError(
      "invalidResponse",
      `GitLab returned an invalid ${field} field.`,
    );
  }
  return value;
}

function requireFullSha(value: unknown, field: string): string {
  const sha = requireString(value, field).toLowerCase();
  if (!/^[0-9a-f]{40,64}$/u.test(sha)) {
    throw new GitLabError(
      "invalidResponse",
      `GitLab returned an invalid ${field} field.`,
    );
  }
  return sha;
}
