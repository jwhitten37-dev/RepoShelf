import { GitLabError } from "./errors.js";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const SHA_PATTERN = /^[0-9a-f]{40,64}$/u;

export interface RemoteFileIdentity {
  readonly instanceId: string;
  readonly projectId: number;
  readonly path: string;
  readonly commitSha: string;
  readonly displayRef: string | undefined;
}

export function createRemoteFilePath(projectId: number, path: string): string {
  validateProjectId(projectId);
  return `/projects/${projectId}/files/${normalizeRepositoryPath(path)}`;
}

export function createRemoteFileQuery(
  commitSha: string,
  displayRef?: string,
): string {
  const normalizedSha = validateSha(commitSha);
  const query = new URLSearchParams();
  query.set("commit", normalizedSha);
  if (displayRef !== undefined && displayRef !== "")
    query.set("ref", displayRef);
  return query.toString();
}

export function parseRemoteFileIdentity(
  authority: string,
  uriPath: string,
  query: string,
): RemoteFileIdentity {
  const instanceId = authority.toLowerCase();
  if (!UUID_PATTERN.test(instanceId)) invalidUri();
  const match = uriPath.match(/^\/projects\/([1-9][0-9]*)\/files\/(.+)$/u);
  if (match?.[1] === undefined || match[2] === undefined) invalidUri();
  const projectId = Number(match[1]);
  validateProjectId(projectId);
  const path = normalizeRepositoryPath(match[2].split("/").join("/"));
  const parameters = new URLSearchParams(query);
  const commit = parameters.get("commit");
  if (commit === null) invalidUri();
  const ref = parameters.get("ref") ?? undefined;
  return {
    instanceId,
    projectId,
    path,
    commitSha: validateSha(commit),
    displayRef: ref,
  };
}

export function normalizeRepositoryPath(path: string): string {
  if (
    path === "" ||
    path.startsWith("/") ||
    path.includes("\\") ||
    path.includes("\0")
  ) {
    throw new GitLabError("configuration", "Invalid remote repository path.");
  }
  const segments = path.split("/");
  if (
    segments.some(
      (segment) => segment === "" || segment === "." || segment === "..",
    )
  ) {
    throw new GitLabError("configuration", "Invalid remote repository path.");
  }
  return segments.join("/");
}

function validateProjectId(projectId: number): void {
  if (!Number.isSafeInteger(projectId) || projectId <= 0) invalidUri();
}

function validateSha(value: string): string {
  const sha = value.toLowerCase();
  if (!SHA_PATTERN.test(sha)) invalidUri();
  return sha;
}

function invalidUri(): never {
  throw new GitLabError("configuration", "Invalid immutable GitLab file URI.");
}
