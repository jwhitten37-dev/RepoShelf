import path from "node:path";
import { lstat, readFile, realpath } from "node:fs/promises";
import { GitLabError } from "../domain/errors.js";
import type { ManagedWorkspaceRecord } from "../domain/models.js";
import type { GitSafetySnapshot } from "../domain/workspaceSafety.js";
import type { GitRunner } from "./gitRunner.js";
import {
  assertNoLinkedComponents,
  assertStrictDescendant,
  normalizeRepositoryUrl,
} from "./pathSafety.js";

const MARKER_RELATIVE_PATH = path.join("reposhelf", "workspace.json");
const OPERATION_PATHS = new Map([
  ["MERGE_HEAD", "merge"],
  ["rebase-merge", "rebase"],
  ["rebase-apply", "rebase"],
  ["CHERRY_PICK_HEAD", "cherry-pick"],
  ["REVERT_HEAD", "revert"],
  ["BISECT_LOG", "bisect"],
  ["sequencer", "sequencer"],
  ["index.lock", "index-lock"],
  ["shallow.lock", "shallow-lock"],
]);

export class WorkspaceSafetyCollector {
  public constructor(
    private readonly git: GitRunner,
    private readonly allowFileUrlForTests = false,
  ) {}

  public async collect(
    record: ManagedWorkspaceRecord,
    signal?: AbortSignal,
    refreshRemote = true,
  ): Promise<GitSafetySnapshot> {
    const checkout = await this.validateOwnership(record);
    const options = signal === undefined ? {} : { signal };
    if (refreshRemote) {
      await this.git.run(
        [
          "-C",
          checkout,
          "fetch",
          "--prune",
          "--no-tags",
          "origin",
          "+refs/heads/*:refs/remotes/origin/*",
        ],
        options,
      );
    }
    const [
      top,
      gitDirectory,
      commonGitDirectory,
      head,
      branch,
      origin,
      status,
      refs,
    ] = await Promise.all([
      this.required(checkout, ["rev-parse", "--show-toplevel"], signal),
      this.required(checkout, ["rev-parse", "--absolute-git-dir"], signal),
      this.required(
        checkout,
        ["rev-parse", "--path-format=absolute", "--git-common-dir"],
        signal,
      ),
      this.required(
        checkout,
        ["rev-parse", "--verify", "HEAD^{commit}"],
        signal,
      ),
      this.optional(checkout, ["symbolic-ref", "--short", "HEAD"], signal),
      this.required(checkout, ["config", "--get", "remote.origin.url"], signal),
      this.required(
        checkout,
        ["status", "--porcelain=v2", "-z", "--untracked-files=all"],
        signal,
      ),
      this.required(
        checkout,
        ["for-each-ref", "--format=%(refname)%00", "refs"],
        signal,
      ),
    ]);
    const canonicalTop = await realpath(top);
    const canonicalGitDirectory = await realpath(gitDirectory);
    const canonicalCommonGitDirectory = await realpath(commonGitDirectory);
    if (!samePath(canonicalTop, checkout)) {
      throw new Error(
        "Git repository top-level does not match the managed workspace.",
      );
    }
    assertStrictDescendant(checkout, canonicalGitDirectory);
    if (!samePath(canonicalGitDirectory, canonicalCommonGitDirectory)) {
      throw new Error(
        "Linked or shared Git worktrees are not supported for release safety.",
      );
    }
    const normalizedOrigin = normalizeRepositoryUrl(
      origin,
      this.allowFileUrlForTests,
    );
    const remoteTarget = `refs/remotes/origin/${record.targetBranch}`;
    const remoteTargetSha = await this.optional(
      checkout,
      ["rev-parse", "--verify", `${remoteTarget}^{commit}`],
      signal,
    );
    const upstreamFields = await this.optional(
      checkout,
      [
        "for-each-ref",
        "--format=%(upstream)%00%(upstream:trackshort)%00",
        `refs/heads/${record.targetBranch}`,
      ],
      signal,
    );
    const upstream = parseUpstream(upstreamFields);
    const localRefs = parseNulList(refs).filter(
      (ref) => !ref.startsWith("refs/remotes/"),
    );
    const localOnlyCounts = await Promise.all(
      localRefs.map(async (ref) =>
        parseCount(
          await this.required(
            checkout,
            ["rev-list", "--count", ref, "--not", "--remotes=origin"],
            signal,
          ),
        ),
      ),
    );
    const operationStates = await detectOperationStates(
      canonicalCommonGitDirectory,
    );
    const sparseCheckout =
      (await this.optional(
        checkout,
        ["config", "--bool", "core.sparseCheckout"],
        signal,
      )) === "true";
    const headAheadOfRemoteTarget =
      remoteTargetSha === undefined
        ? undefined
        : parseCount(
            await this.required(
              checkout,
              ["rev-list", "--count", "HEAD", "--not", remoteTarget],
              signal,
            ),
          );
    const aheadBehind = await collectAheadBehind(
      this.git,
      checkout,
      upstream.name,
      signal,
    );
    return {
      schemaVersion: 1,
      capturedAt: new Date().toISOString(),
      topLevel: canonicalTop,
      gitDirectory: canonicalGitDirectory,
      commonGitDirectory: canonicalCommonGitDirectory,
      branch,
      headSha: head.toLowerCase(),
      originUrl: normalizedOrigin,
      statusEntryCount: parsePorcelainV2Z(status).length,
      operationStates,
      upstream: upstream.name,
      ahead: aheadBehind?.ahead,
      behind: aheadBehind?.behind,
      remoteTarget,
      remoteTargetSha: remoteTargetSha?.toLowerCase(),
      headAheadOfRemoteTarget,
      localRefCount: localRefs.length,
      localOnlyRefCount: localOnlyCounts.filter((count) => count > 0).length,
      unrelatedLocalOnlyRefCount: localOnlyCounts.filter(
        (count, index) =>
          count > 0 && localRefs[index] !== `refs/heads/${record.targetBranch}`,
      ).length,
      sparseCheckout,
    };
  }

  private async validateOwnership(
    record: ManagedWorkspaceRecord,
  ): Promise<string> {
    await assertNoLinkedComponents(record.cloneRoot);
    await assertNoLinkedComponents(record.localPath);
    const cloneRoot = await realpath(record.cloneRoot);
    const checkout = await realpath(record.localPath);
    assertStrictDescendant(cloneRoot, checkout);
    const topLevel = await realpath(
      await this.required(checkout, ["rev-parse", "--show-toplevel"]),
    );
    if (!samePath(topLevel, checkout)) {
      throw new Error(
        "Git repository top-level does not match the managed workspace.",
      );
    }
    const gitDirectory = await realpath(
      await this.required(checkout, ["rev-parse", "--absolute-git-dir"]),
    );
    assertStrictDescendant(checkout, gitDirectory);
    const commonGitDirectory = await realpath(
      await this.required(checkout, [
        "rev-parse",
        "--path-format=absolute",
        "--git-common-dir",
      ]),
    );
    if (!samePath(gitDirectory, commonGitDirectory)) {
      throw new Error(
        "Linked or shared Git worktrees are not supported for release safety.",
      );
    }
    const marker = parseManagedWorkspaceMarker(
      JSON.parse(
        await readFile(path.join(gitDirectory, MARKER_RELATIVE_PATH), "utf8"),
      ) as unknown,
    );
    if (
      !sameOwnership(record, marker) ||
      !samePath(marker.localPath, checkout)
    ) {
      throw new Error(
        "Registry and ownership marker do not identify the same workspace.",
      );
    }
    const origin = normalizeRepositoryUrl(
      await this.required(checkout, ["config", "--get", "remote.origin.url"]),
      this.allowFileUrlForTests,
    );
    if (origin !== record.canonicalRepositoryUrl) {
      throw new Error("The Git origin does not match the ownership record.");
    }
    return checkout;
  }

  private async required(
    checkout: string,
    args: readonly string[],
    signal?: AbortSignal,
  ): Promise<string> {
    return (
      await this.git.run(
        ["-C", checkout, ...args],
        signal === undefined ? {} : { signal },
      )
    ).stdout;
  }

  private async optional(
    checkout: string,
    args: readonly string[],
    signal?: AbortSignal,
  ): Promise<string | undefined> {
    try {
      const value = await this.required(checkout, args, signal);
      return value === "" ? undefined : value;
    } catch (error) {
      if (
        error instanceof GitLabError &&
        (error.code === "cancelled" || error.code === "timeout")
      ) {
        throw error;
      }
      return undefined;
    }
  }
}

export function parsePorcelainV2Z(output: string): readonly string[] {
  const fields = output.split("\0");
  const entries: string[] = [];
  for (let index = 0; index < fields.length; index += 1) {
    const field = fields[index];
    if (field === undefined || field === "") continue;
    entries.push(field);
    if (field.startsWith("2 ")) index += 1;
  }
  return entries;
}

export function parseAheadBehind(output: string): {
  readonly ahead: number;
  readonly behind: number;
} {
  const match = /^(\d+)\s+(\d+)$/u.exec(output.trim());
  if (match === null)
    throw new Error("Git returned an invalid ahead/behind value.");
  return { ahead: Number(match[1]), behind: Number(match[2]) };
}

async function collectAheadBehind(
  git: GitRunner,
  checkout: string,
  upstream: string | undefined,
  signal?: AbortSignal,
): Promise<{ readonly ahead: number; readonly behind: number } | undefined> {
  if (upstream === undefined) return undefined;
  try {
    const result = await git.run(
      [
        "-C",
        checkout,
        "rev-list",
        "--left-right",
        "--count",
        `HEAD...${upstream}`,
      ],
      signal === undefined ? {} : { signal },
    );
    return parseAheadBehind(result.stdout);
  } catch (error) {
    if (
      error instanceof GitLabError &&
      (error.code === "cancelled" || error.code === "timeout")
    ) {
      throw error;
    }
    return undefined;
  }
}

function parseUpstream(value: string | undefined): {
  readonly name: string | undefined;
} {
  if (value === undefined) return { name: undefined };
  const [name] = value.split("\0");
  return { name: name === "" ? undefined : name };
}

function parseNulList(value: string): readonly string[] {
  return value
    .split("\0")
    .map((item) => item.trim())
    .filter((item) => item !== "");
}

function parseCount(value: string): number {
  if (!/^\d+$/u.test(value)) throw new Error("Git returned an invalid count.");
  return Number(value);
}

async function detectOperationStates(
  gitDirectory: string,
): Promise<readonly string[]> {
  const states = new Set<string>();
  await Promise.all(
    [...OPERATION_PATHS].map(async ([relative, state]) => {
      try {
        await lstat(path.join(gitDirectory, relative));
        states.add(state);
      } catch (error) {
        if (!isNotFound(error)) throw error;
      }
    }),
  );
  return [...states].sort();
}

function parseManagedWorkspaceMarker(value: unknown): ManagedWorkspaceRecord {
  if (
    !isRecord(value) ||
    value.schemaVersion !== 1 ||
    typeof value.creationNonce !== "string"
  ) {
    throw new Error("Managed workspace marker is invalid or unsupported.");
  }
  const requiredStrings = [
    "workspaceId",
    "instanceId",
    "projectPath",
    "canonicalRepositoryUrl",
    "targetBranch",
    "pinnedCommitSha",
    "localPath",
    "cloneRoot",
    "createdAt",
    "lastOpenedAt",
  ];
  if (
    requiredStrings.some((key) => typeof value[key] !== "string") ||
    typeof value.projectId !== "number" ||
    (value.cloneMode !== "partialSparse" && value.cloneMode !== "full") ||
    !Array.isArray(value.sparseDirectories) ||
    !value.sparseDirectories.every((item) => typeof item === "string") ||
    !(typeof value.revealPath === "string" || value.revealPath === undefined)
  ) {
    throw new Error("Managed workspace marker is invalid or unsupported.");
  }
  return value as unknown as ManagedWorkspaceRecord;
}

function sameOwnership(
  left: ManagedWorkspaceRecord,
  right: ManagedWorkspaceRecord,
): boolean {
  return (
    left.workspaceId === right.workspaceId &&
    left.instanceId === right.instanceId &&
    left.projectId === right.projectId &&
    left.projectPath === right.projectPath &&
    left.canonicalRepositoryUrl === right.canonicalRepositoryUrl &&
    left.targetBranch === right.targetBranch &&
    left.pinnedCommitSha === right.pinnedCommitSha &&
    left.cloneMode === right.cloneMode &&
    left.sparseDirectories.length === right.sparseDirectories.length &&
    left.sparseDirectories.every(
      (directory, index) => directory === right.sparseDirectories[index],
    ) &&
    samePath(left.localPath, right.localPath) &&
    samePath(left.cloneRoot, right.cloneRoot) &&
    left.revealPath === right.revealPath &&
    left.createdAt === right.createdAt &&
    left.lastOpenedAt === right.lastOpenedAt
  );
}

function samePath(left: string, right: string): boolean {
  return process.platform === "win32"
    ? left.localeCompare(right, undefined, { sensitivity: "accent" }) === 0
    : left === right;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNotFound(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "ENOENT"
  );
}
