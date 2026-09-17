import { createHash, randomUUID } from "node:crypto";
import { homedir } from "node:os";
import path from "node:path";
import { lstat, mkdir, realpath } from "node:fs/promises";
import { GitLabError } from "../domain/errors.js";

export interface AllocatedWorkspacePaths {
  readonly cloneRoot: string;
  readonly finalPath: string;
  readonly temporaryPath: string;
  readonly temporaryMarkerPath: string;
}

export async function validateCloneRoot(
  requestedRoot: string,
  extensionSourceRoot: string,
): Promise<string> {
  if (!path.isAbsolute(requestedRoot)) {
    throw new GitLabError(
      "configuration",
      "The managed clone root must be absolute.",
    );
  }
  const resolvedInput = path.resolve(requestedRoot);
  const filesystemRoot = path.parse(resolvedInput).root;
  if (samePath(resolvedInput, filesystemRoot)) {
    throw new GitLabError(
      "configuration",
      "A filesystem root cannot be used as the managed clone root.",
    );
  }
  if (samePath(resolvedInput, path.resolve(homedir()))) {
    throw new GitLabError(
      "configuration",
      "The home/profile directory cannot be used as the managed clone root.",
    );
  }
  if (
    isWithin(resolvedInput, path.resolve(extensionSourceRoot)) ||
    isWithin(path.resolve(extensionSourceRoot), resolvedInput)
  ) {
    throw new GitLabError(
      "configuration",
      "The extension source folder cannot contain or be contained by the managed clone root.",
    );
  }

  await assertExistingAncestorsNotLinked(resolvedInput);
  await mkdir(resolvedInput, { recursive: true });
  await assertNoLinkedComponents(resolvedInput);
  return realpath(resolvedInput);
}

export function allocateWorkspacePaths(
  cloneRoot: string,
  instanceId: string,
  projectId: number,
  projectPath: string,
  branch: string,
): AllocatedWorkspacePaths {
  const projectSlug = slug(projectPath.split("/").at(-1) ?? "project");
  const branchSlug = slug(branch);
  const branchHash = createHash("sha256")
    .update(branch)
    .digest("hex")
    .slice(0, 10);
  const parent = path.join(
    cloneRoot,
    instanceId,
    `${projectId}-${projectSlug}`,
  );
  const finalPath = path.join(parent, `${branchSlug}-${branchHash}`);
  const operationId = randomUUID();
  const temporaryPath = path.join(parent, `.tmp-${operationId}`);
  return {
    cloneRoot,
    finalPath,
    temporaryPath,
    temporaryMarkerPath: `${temporaryPath}.reposhelf-temp.json`,
  };
}

export function assertStrictDescendant(root: string, candidate: string): void {
  if (!isWithin(candidate, root)) {
    throw new GitLabError(
      "configuration",
      "Managed workspace path escaped the configured clone root.",
    );
  }
}

export async function assertNoLinkedComponents(
  candidate: string,
): Promise<void> {
  const absolute = path.resolve(candidate);
  const parsed = path.parse(absolute);
  let current = parsed.root;
  for (const segment of absolute
    .slice(parsed.root.length)
    .split(path.sep)
    .filter(Boolean)) {
    current = path.join(current, segment);
    const stat = await lstat(current);
    if (stat.isSymbolicLink()) {
      throw new GitLabError(
        "configuration",
        `Linked path components are not allowed: ${current}`,
      );
    }
  }
}

async function assertExistingAncestorsNotLinked(
  candidate: string,
): Promise<void> {
  let current = path.resolve(candidate);
  const root = path.parse(current).root;
  const candidates = [current];
  while (current !== root) {
    current = path.dirname(current);
    candidates.push(current);
  }
  for (const existingCandidate of candidates) {
    try {
      const stat = await lstat(existingCandidate);
      if (stat.isSymbolicLink()) {
        throw new GitLabError(
          "configuration",
          `Linked path components are not allowed: ${existingCandidate}`,
        );
      }
      await assertNoLinkedComponents(existingCandidate);
      return;
    } catch (error) {
      if (isNotFound(error)) continue;
      throw error;
    }
  }
  throw new GitLabError(
    "configuration",
    "Unable to resolve an existing ancestor for the managed clone root.",
  );
}

export function normalizeRepositoryUrl(
  value: string,
  allowFileUrlForTests = false,
): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch (error) {
    throw new GitLabError("configuration", "Git repository URL is invalid.", {
      cause: error,
    });
  }
  if (
    (url.protocol !== "https:" &&
      !(allowFileUrlForTests && url.protocol === "file:")) ||
    url.username !== "" ||
    url.password !== ""
  ) {
    throw new GitLabError(
      "configuration",
      "Managed Git remotes must use HTTPS without embedded credentials.",
    );
  }
  url.hash = "";
  url.search = "";
  return url
    .toString()
    .replace(/\/$/u, "")
    .replace(/\.git$/u, "");
}

export function normalizeSparseDirectory(value: string): string {
  if (value === "") return "";
  const normalized = value.replaceAll("\\", "/").replace(/^\/+|\/+$/gu, "");
  if (
    normalized === "" ||
    normalized
      .split("/")
      .some(
        (segment) =>
          segment === "" ||
          segment === "." ||
          segment === ".." ||
          segment.includes("\0"),
      )
  ) {
    throw new GitLabError(
      "configuration",
      "Invalid sparse checkout directory.",
    );
  }
  return normalized;
}

function slug(value: string): string {
  const normalized = value
    .normalize("NFKD")
    .replace(/[^A-Za-z0-9._-]+/gu, "-")
    .replace(/^[. -]+|[. -]+$/gu, "")
    .slice(0, 48);
  const safe = normalized === "" ? "item" : normalized;
  return /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])$/iu.test(safe)
    ? `_${safe}`
    : safe;
}

function isWithin(candidate: string, root: string): boolean {
  const relative = path.relative(root, candidate);
  return (
    relative !== "" &&
    !relative.startsWith(`..${path.sep}`) &&
    relative !== ".." &&
    !path.isAbsolute(relative)
  );
}

function samePath(left: string, right: string): boolean {
  return process.platform === "win32"
    ? left.localeCompare(right, undefined, { sensitivity: "accent" }) === 0
    : left === right;
}

function isNotFound(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "ENOENT"
  );
}
