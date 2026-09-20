import { randomUUID } from "node:crypto";
import path from "node:path";
import {
  access,
  lstat,
  mkdir,
  readFile,
  realpath,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { constants } from "node:fs";
import { GitLabError } from "../domain/errors.js";
import type { CloneMode, ManagedWorkspaceRecord } from "../domain/models.js";
import type { GitRunner } from "./gitRunner.js";
import {
  allocateWorkspacePaths,
  assertNoLinkedComponents,
  assertStrictDescendant,
  normalizeRepositoryUrl,
  normalizeSparseDirectory,
  validateCloneRoot,
} from "./pathSafety.js";

const MARKER_RELATIVE_PATH = path.join("reposhelf", "workspace.json");
const PLACEMENT_ATTEMPTS = 8;
const PLACEMENT_INITIAL_RETRY_MS = 100;
const PLACEMENT_MAX_RETRY_MS = 1_000;

export interface WorkspaceRegistry {
  getByLocalPath(localPath: string): ManagedWorkspaceRecord | undefined;
  save(record: ManagedWorkspaceRecord): Promise<void>;
}

export interface MaterializationRequest {
  readonly extensionSourceRoot: string;
  readonly cloneRoot: string;
  readonly instanceId: string;
  readonly projectId: number;
  readonly projectPath: string;
  readonly repositoryUrl: string;
  readonly sourceBranch: string;
  readonly targetBranch: string;
  readonly pinnedCommitSha: string;
  readonly cloneMode: CloneMode;
  readonly sparseDirectories: readonly string[];
  readonly revealPath?: string;
  readonly signal?: AbortSignal;
}

export interface MaterializationResult {
  readonly record: ManagedWorkspaceRecord;
  readonly reused: boolean;
}

export class MaterializationService {
  public constructor(
    private readonly git: GitRunner,
    private readonly registry: WorkspaceRegistry,
    private readonly allowFileUrlForTests = false,
  ) {}

  public async materialize(
    request: MaterializationRequest,
  ): Promise<MaterializationResult> {
    const cloneRoot = await validateCloneRoot(
      request.cloneRoot,
      request.extensionSourceRoot,
    );
    const repositoryUrl = normalizeRepositoryUrl(
      request.repositoryUrl,
      this.allowFileUrlForTests,
    );
    const sparseDirectories = unique(
      request.sparseDirectories.map(normalizeSparseDirectory),
    );
    if (
      request.cloneMode === "partialSparse" &&
      sparseDirectories.length === 0
    ) {
      throw new GitLabError(
        "configuration",
        "Partial sparse materialization requires a directory selection.",
      );
    }
    const paths = allocateWorkspacePaths(
      cloneRoot,
      request.instanceId,
      request.projectId,
      request.projectPath,
      request.targetBranch,
    );
    assertStrictDescendant(cloneRoot, paths.finalPath);
    assertStrictDescendant(cloneRoot, paths.temporaryPath);
    await mkdir(path.dirname(paths.finalPath), { recursive: true });
    await assertNoLinkedComponents(path.dirname(paths.finalPath));

    if (await exists(paths.finalPath)) {
      const existing = await this.validateExisting(paths.finalPath, request);
      await this.registry.save(existing);
      return { record: existing, reused: true };
    }

    const operationId = randomUUID();
    await writeJsonExclusive(paths.temporaryMarkerPath, {
      schemaVersion: 1,
      operationId,
      temporaryDirectoryName: path.basename(paths.temporaryPath),
      createdAt: new Date().toISOString(),
    });

    try {
      await this.clone(
        request,
        request.repositoryUrl,
        paths.temporaryPath,
        sparseDirectories,
      );
      if (request.targetBranch !== request.sourceBranch) {
        await this.git.run(
          [
            "-C",
            paths.temporaryPath,
            "check-ref-format",
            "--branch",
            request.targetBranch,
          ],
          request.signal === undefined ? {} : { signal: request.signal },
        );
        await this.git.run(
          ["-C", paths.temporaryPath, "switch", "-c", request.targetBranch],
          request.signal === undefined ? {} : { signal: request.signal },
        );
      }
      const snapshot = await this.validateRepository(
        paths.temporaryPath,
        request,
        repositoryUrl,
      );
      const now = new Date().toISOString();
      const record: ManagedWorkspaceRecord = {
        schemaVersion: 1,
        workspaceId: randomUUID(),
        instanceId: request.instanceId,
        projectId: request.projectId,
        projectPath: request.projectPath,
        canonicalRepositoryUrl: repositoryUrl,
        targetBranch: request.targetBranch,
        pinnedCommitSha: snapshot.head,
        cloneMode: request.cloneMode,
        sparseDirectories,
        localPath: paths.finalPath,
        cloneRoot,
        revealPath: request.revealPath,
        createdAt: now,
        lastOpenedAt: now,
      };
      const markerPath = path.join(snapshot.gitDir, MARKER_RELATIVE_PATH);
      await mkdir(path.dirname(markerPath), { recursive: true });
      await writeJsonExclusive(markerPath, {
        ...record,
        creationNonce: randomUUID(),
      });
      await placeWorkspace(
        paths.temporaryPath,
        paths.finalPath,
        request.signal,
      );
      await rm(paths.temporaryMarkerPath, { force: true });
      try {
        await this.registry.save(record);
      } catch (error) {
        throw new GitLabError(
          "configuration",
          `The checkout was created safely at ${paths.finalPath}, but its registry entry could not be saved. Retry the same action to reconcile it.`,
          { cause: error },
        );
      }
      return { record, reused: false };
    } catch (error) {
      await this.cleanupTemporary(
        paths.temporaryPath,
        paths.temporaryMarkerPath,
      );
      throw error;
    }
  }

  private async clone(
    request: MaterializationRequest,
    repositoryUrl: string,
    destination: string,
    sparseDirectories: readonly string[],
  ): Promise<void> {
    const args = [
      "clone",
      "--origin",
      "origin",
      "--branch",
      request.sourceBranch,
    ];
    if (request.cloneMode === "partialSparse") {
      args.push(
        "--single-branch",
        "--no-tags",
        "--filter=blob:none",
        "--sparse",
      );
    }
    args.push("--", repositoryUrl, destination);
    await this.git.run(args, {
      ...(request.signal === undefined ? {} : { signal: request.signal }),
    });
    if (request.cloneMode === "partialSparse") {
      await this.git.run(
        ["-C", destination, "sparse-checkout", "set", "--cone", "--stdin"],
        {
          ...(request.signal === undefined ? {} : { signal: request.signal }),
          stdin: `${sparseDirectories.join("\n")}\n`,
        },
      );
    }
  }

  private async validateRepository(
    checkout: string,
    request: MaterializationRequest,
    expectedRepositoryUrl: string,
  ): Promise<{ readonly gitDir: string; readonly head: string }> {
    const topLevel = await this.git.run([
      "-C",
      checkout,
      "rev-parse",
      "--show-toplevel",
    ]);
    const canonicalTop = await realpath(topLevel.stdout);
    const canonicalCheckout = await realpath(checkout);
    if (!samePath(canonicalTop, canonicalCheckout)) {
      throw new GitLabError(
        "configuration",
        "Git repository top-level does not match the managed checkout.",
      );
    }
    const gitDirResult = await this.git.run([
      "-C",
      checkout,
      "rev-parse",
      "--absolute-git-dir",
    ]);
    const gitDir = await realpath(gitDirResult.stdout);
    assertStrictDescendant(canonicalCheckout, gitDir);
    const head = (
      await this.git.run([
        "-C",
        checkout,
        "rev-parse",
        "--verify",
        "HEAD^{commit}",
      ])
    ).stdout.toLowerCase();
    const branch = (
      await this.git.run(["-C", checkout, "symbolic-ref", "--short", "HEAD"])
    ).stdout;
    const origin = (
      await this.git.run([
        "-C",
        checkout,
        "config",
        "--get",
        "remote.origin.url",
      ])
    ).stdout;
    if (head !== request.pinnedCommitSha.toLowerCase()) {
      throw new GitLabError(
        "configuration",
        "The remote branch moved after browsing. Refresh the catalog and retry materialization.",
      );
    }
    if (branch !== request.targetBranch) {
      throw new GitLabError(
        "configuration",
        "Git checked out an unexpected branch.",
      );
    }
    if (
      normalizeRepositoryUrl(origin, this.allowFileUrlForTests) !==
      expectedRepositoryUrl
    ) {
      throw new GitLabError(
        "configuration",
        "Git configured an unexpected origin URL.",
      );
    }
    if (request.cloneMode === "partialSparse") {
      const promisor = (
        await this.git.run([
          "-C",
          checkout,
          "config",
          "--get",
          "remote.origin.promisor",
        ])
      ).stdout;
      const filter = (
        await this.git.run([
          "-C",
          checkout,
          "config",
          "--get",
          "remote.origin.partialclonefilter",
        ])
      ).stdout;
      const sparse = (
        await this.git.run([
          "-C",
          checkout,
          "config",
          "--bool",
          "core.sparseCheckout",
        ])
      ).stdout;
      if (promisor !== "true" || filter !== "blob:none" || sparse !== "true") {
        throw new GitLabError(
          "configuration",
          "Git did not configure the requested partial+sparse checkout.",
        );
      }
    }
    return { gitDir, head };
  }

  private async validateExisting(
    localPath: string,
    request: MaterializationRequest,
  ): Promise<ManagedWorkspaceRecord> {
    await assertNoLinkedComponents(localPath);
    const gitDir = (
      await this.git.run(["-C", localPath, "rev-parse", "--absolute-git-dir"])
    ).stdout;
    const marker = parseRecord(
      JSON.parse(
        await readFile(path.join(gitDir, MARKER_RELATIVE_PATH), "utf8"),
      ) as unknown,
    );
    if (
      marker.instanceId !== request.instanceId ||
      marker.projectId !== request.projectId ||
      marker.targetBranch !== request.targetBranch ||
      !samePath(marker.localPath, localPath)
    ) {
      throw new GitLabError(
        "configuration",
        "An existing directory is not the expected managed workspace.",
      );
    }
    const requestedSparseDirectories = request.sparseDirectories.map(
      normalizeSparseDirectory,
    );
    if (
      marker.cloneMode === "partialSparse" &&
      (request.cloneMode === "full" ||
        requestedSparseDirectories.some(
          (directory) => !marker.sparseDirectories.includes(directory),
        ))
    ) {
      throw new GitLabError(
        "configuration",
        "The existing sparse workspace does not contain the requested scope. Expanding sparse workspaces is added in Phase 5.",
      );
    }
    const topLevel = await realpath(
      (await this.git.run(["-C", localPath, "rev-parse", "--show-toplevel"]))
        .stdout,
    );
    const canonicalLocalPath = await realpath(localPath);
    const branch = (
      await this.git.run(["-C", localPath, "symbolic-ref", "--short", "HEAD"])
    ).stdout;
    const origin = (
      await this.git.run([
        "-C",
        localPath,
        "config",
        "--get",
        "remote.origin.url",
      ])
    ).stdout;
    if (
      !samePath(topLevel, canonicalLocalPath) ||
      branch !== marker.targetBranch ||
      normalizeRepositoryUrl(origin, this.allowFileUrlForTests) !==
        marker.canonicalRepositoryUrl
    ) {
      throw new GitLabError(
        "configuration",
        "The existing managed workspace no longer matches its ownership marker.",
      );
    }
    return marker;
  }

  private async cleanupTemporary(
    temporaryPath: string,
    markerPath: string,
  ): Promise<void> {
    try {
      const marker = JSON.parse(await readFile(markerPath, "utf8")) as unknown;
      if (
        !isRecord(marker) ||
        marker.temporaryDirectoryName !== path.basename(temporaryPath)
      )
        return;
      if (await exists(temporaryPath)) {
        const stat = await lstat(temporaryPath);
        if (stat.isSymbolicLink()) return;
        await rm(temporaryPath, {
          recursive: true,
          force: true,
          maxRetries: 2,
        });
      }
      await rm(markerPath, { force: true });
    } catch {
      // A failed guarded cleanup is intentionally left for later diagnostics.
    }
  }
}

export async function placeWorkspace(
  temporaryPath: string,
  finalPath: string,
  signal?: AbortSignal,
  renameDirectory: (
    source: string,
    destination: string,
  ) => Promise<void> = rename,
  wait: (milliseconds: number, signal?: AbortSignal) => Promise<void> = waitFor,
): Promise<void> {
  for (let attempt = 1; attempt <= PLACEMENT_ATTEMPTS; attempt += 1) {
    throwIfCancelled(signal);
    try {
      await renameDirectory(temporaryPath, finalPath);
      return;
    } catch (error) {
      if (!isTransientPlacementError(error) || attempt === PLACEMENT_ATTEMPTS) {
        throw error;
      }
      const delay = Math.min(
        PLACEMENT_INITIAL_RETRY_MS * 2 ** (attempt - 1),
        PLACEMENT_MAX_RETRY_MS,
      );
      await wait(delay, signal);
    }
  }
}

function isTransientPlacementError(error: unknown): boolean {
  if (typeof error !== "object" || error === null || !("code" in error)) {
    return false;
  }
  return error.code === "EPERM" || error.code === "EBUSY";
}

function throwIfCancelled(signal?: AbortSignal): void {
  if (signal?.aborted === true) {
    throw new GitLabError("cancelled", "Workspace materialization cancelled.");
  }
}

function waitFor(milliseconds: number, signal?: AbortSignal): Promise<void> {
  throwIfCancelled(signal);
  return new Promise((resolve, reject) => {
    const complete = (): void => {
      signal?.removeEventListener("abort", cancel);
      resolve();
    };
    const cancel = (): void => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", cancel);
      reject(
        new GitLabError("cancelled", "Workspace materialization cancelled."),
      );
    };
    const timer = setTimeout(complete, milliseconds);
    signal?.addEventListener("abort", cancel, { once: true });
  });
}

async function writeJsonExclusive(file: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify(value, undefined, 2)}\n`, {
    encoding: "utf8",
    flag: "wx",
    mode: 0o600,
  });
}

async function exists(candidate: string): Promise<boolean> {
  try {
    await access(candidate, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

function parseRecord(value: unknown): ManagedWorkspaceRecord {
  if (
    !isRecord(value) ||
    value.schemaVersion !== 1 ||
    typeof value.workspaceId !== "string" ||
    typeof value.instanceId !== "string" ||
    typeof value.projectId !== "number" ||
    typeof value.projectPath !== "string" ||
    typeof value.canonicalRepositoryUrl !== "string" ||
    typeof value.targetBranch !== "string" ||
    typeof value.pinnedCommitSha !== "string" ||
    (value.cloneMode !== "partialSparse" && value.cloneMode !== "full") ||
    !Array.isArray(value.sparseDirectories) ||
    !value.sparseDirectories.every((item) => typeof item === "string") ||
    typeof value.localPath !== "string" ||
    typeof value.cloneRoot !== "string" ||
    !(typeof value.revealPath === "string" || value.revealPath === undefined) ||
    typeof value.createdAt !== "string" ||
    typeof value.lastOpenedAt !== "string" ||
    typeof value.creationNonce !== "string" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(
      value.creationNonce,
    )
  ) {
    throw new GitLabError(
      "configuration",
      "Managed workspace marker is invalid or unsupported.",
    );
  }
  return {
    schemaVersion: 1,
    workspaceId: value.workspaceId,
    instanceId: value.instanceId,
    projectId: value.projectId,
    projectPath: value.projectPath,
    canonicalRepositoryUrl: value.canonicalRepositoryUrl,
    targetBranch: value.targetBranch,
    pinnedCommitSha: value.pinnedCommitSha,
    cloneMode: value.cloneMode,
    sparseDirectories: value.sparseDirectories,
    localPath: value.localPath,
    cloneRoot: value.cloneRoot,
    revealPath: value.revealPath,
    createdAt: value.createdAt,
    lastOpenedAt: value.lastOpenedAt,
  };
}

function unique(values: readonly string[]): readonly string[] {
  return [...new Set(values)];
}

function samePath(left: string, right: string): boolean {
  return process.platform === "win32"
    ? left.localeCompare(right, undefined, { sensitivity: "accent" }) === 0
    : left === right;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
