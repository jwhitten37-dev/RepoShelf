import { access, lstat, opendir, rm } from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";
import { GitLabError } from "../domain/errors.js";
import type { ManagedWorkspaceRecord } from "../domain/models.js";
import {
  decidePostPushSafety,
  decidePushReadiness,
  decideWorkspaceSafety,
  type GitSafetySnapshot,
  type WorkspaceSafetyDecision,
} from "../domain/workspaceSafety.js";
import type { GitRunner } from "./gitRunner.js";
import type { WorkspaceSafetyCollector } from "./workspaceSafety.js";

const CAPABILITY_LIFETIME_MS = 30_000;
const REMOVAL_MAX_RETRIES = 10;
const REMOVAL_RETRY_DELAY_MS = 500;

export interface ReleaseRegistry {
  getByLocalPath(localPath: string): ManagedWorkspaceRecord | undefined;
  remove(workspaceId: string): Promise<void>;
}

export interface ReleaseAssessment {
  readonly snapshot: GitSafetySnapshot;
  readonly decision: WorkspaceSafetyDecision;
}

export interface DeletionCapability {
  readonly workspaceId: string;
  readonly canonicalPath: string;
}

export interface WorkspaceRemover {
  remove(canonicalPath: string): Promise<void>;
  exists(canonicalPath: string): Promise<boolean>;
}

interface IssuedCapability extends DeletionCapability {
  readonly record: ManagedWorkspaceRecord;
  readonly headSha: string;
  readonly expiresAt: number;
}

export class WorkspaceReleaseService {
  private readonly capabilities = new WeakSet<object>();

  public constructor(
    private readonly git: GitRunner,
    private readonly collector: WorkspaceSafetyCollector,
    private readonly registry: ReleaseRegistry,
    private readonly now: () => number = Date.now,
    private readonly remover: WorkspaceRemover = new NativeWorkspaceRemover(),
  ) {}

  public async assessRelease(
    record: ManagedWorkspaceRecord,
    unsavedEditorCount: number,
    signal?: AbortSignal,
  ): Promise<ReleaseAssessment> {
    const snapshot = await this.collector.collect(record, signal);
    return {
      snapshot,
      decision: decideWorkspaceSafety(
        evidence(record, unsavedEditorCount, snapshot),
      ),
    };
  }

  public async assessPush(
    record: ManagedWorkspaceRecord,
    unsavedEditorCount: number,
    signal?: AbortSignal,
  ): Promise<ReleaseAssessment> {
    const snapshot = await this.collector.collect(record, signal);
    return {
      snapshot,
      decision: decidePushReadiness(
        evidence(record, unsavedEditorCount, snapshot),
      ),
    };
  }

  public async measureWorkspaceBytes(
    record: ManagedWorkspaceRecord,
    signal?: AbortSignal,
  ): Promise<number> {
    await this.collector.collect(record, signal, false);
    return measureTree(record.localPath, signal);
  }

  public async push(
    record: ManagedWorkspaceRecord,
    unsavedEditorCount: number,
    signal?: AbortSignal,
  ): Promise<ReleaseAssessment> {
    const before = await this.collector.collect(record, signal);
    const readiness = decidePushReadiness(
      evidence(record, unsavedEditorCount, before),
    );
    if (!readiness.safe) return { snapshot: before, decision: readiness };

    await this.git.run(
      [
        "-C",
        record.localPath,
        "push",
        "--porcelain",
        "origin",
        `HEAD:refs/heads/${record.targetBranch}`,
      ],
      signal === undefined ? {} : { signal },
    );
    const after = await this.collector.collect(record, signal);
    return {
      snapshot: after,
      decision: decidePostPushSafety(
        evidence(record, unsavedEditorCount, after),
      ),
    };
  }

  public async prepareDeletion(
    record: ManagedWorkspaceRecord,
    expectedHeadSha: string,
    unsavedEditorCount: number,
    signal?: AbortSignal,
  ): Promise<DeletionCapability> {
    const registered = this.registry.getByLocalPath(record.localPath);
    if (registered?.workspaceId !== record.workspaceId) {
      throw new GitLabError(
        "configuration",
        "The managed workspace registry changed before release.",
      );
    }
    const assessment = await this.assessRelease(
      record,
      unsavedEditorCount,
      signal,
    );
    if (!assessment.decision.safe) {
      throw blockedError(assessment.decision);
    }
    if (assessment.snapshot.headSha !== expectedHeadSha) {
      throw new GitLabError(
        "configuration",
        "Local HEAD changed after release confirmation.",
      );
    }
    const capability: IssuedCapability = Object.freeze({
      workspaceId: record.workspaceId,
      canonicalPath: assessment.snapshot.topLevel,
      record,
      headSha: assessment.snapshot.headSha,
      expiresAt: this.now() + CAPABILITY_LIFETIME_MS,
    });
    this.capabilities.add(capability);
    return capability;
  }

  public async delete(
    capability: DeletionCapability,
    unsavedEditorCount: number,
  ): Promise<void> {
    const issued = capability as IssuedCapability;
    if (!this.capabilities.has(issued)) {
      throw new GitLabError(
        "configuration",
        "Workspace deletion requires a fresh RepoShelf safety capability.",
      );
    }
    this.capabilities.delete(issued);
    if (this.now() > issued.expiresAt) {
      throw new GitLabError(
        "configuration",
        "Workspace deletion safety evidence expired; run the checks again.",
      );
    }
    if (unsavedEditorCount > 0) {
      throw new GitLabError(
        "configuration",
        "Unsaved editor buffers appeared after release confirmation.",
      );
    }
    const registered = this.registry.getByLocalPath(issued.canonicalPath);
    if (registered?.workspaceId !== issued.workspaceId) {
      throw new GitLabError(
        "configuration",
        "The managed workspace registry changed before deletion.",
      );
    }
    const finalSnapshot = await this.collector.collect(
      issued.record,
      undefined,
      false,
    );
    const finalDecision = decideWorkspaceSafety(
      evidence(issued.record, 0, finalSnapshot),
    );
    if (!finalDecision.safe) {
      throw blockedError(finalDecision);
    }
    if (finalSnapshot.headSha !== issued.headSha) {
      throw new GitLabError(
        "configuration",
        "Local HEAD changed after deletion safety preparation.",
      );
    }

    try {
      await this.remover.remove(issued.canonicalPath);
    } catch (error) {
      throw new GitLabError(
        "configuration",
        `The managed workspace could not be completely removed (${filesystemErrorDetail(error)}); its registry record was retained.`,
        { cause: error },
      );
    }
    if (await this.remover.exists(issued.canonicalPath)) {
      throw new GitLabError(
        "configuration",
        "The managed workspace still exists after removal; its registry record was retained.",
      );
    }
    await this.registry.remove(issued.workspaceId);
  }
}

class NativeWorkspaceRemover implements WorkspaceRemover {
  public async remove(canonicalPath: string): Promise<void> {
    await rm(canonicalPath, {
      recursive: true,
      force: false,
      maxRetries: REMOVAL_MAX_RETRIES,
      retryDelay: REMOVAL_RETRY_DELAY_MS,
    });
  }

  public exists(canonicalPath: string): Promise<boolean> {
    return exists(canonicalPath);
  }
}

function filesystemErrorDetail(error: unknown): string {
  if (!isUnknownRecord(error)) return "unknown error";
  const code = safeErrorField(error.code, /^[A-Z0-9_]+$/u);
  const syscall = safeErrorField(error.syscall, /^[a-z]+$/u);
  if (code === undefined && syscall === undefined) return "unknown error";
  return [code, syscall]
    .filter((value) => value !== undefined)
    .join(" during ");
}

function safeErrorField(value: unknown, pattern: RegExp): string | undefined {
  return typeof value === "string" && pattern.test(value) ? value : undefined;
}

function isUnknownRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function evidence(
  record: ManagedWorkspaceRecord,
  unsavedEditorCount: number,
  snapshot: GitSafetySnapshot,
) {
  return {
    ownershipValid: true,
    unsavedEditorCount,
    expectedBranch: record.targetBranch,
    expectedOriginUrl: record.canonicalRepositoryUrl,
    snapshot,
  };
}

function blockedError(decision: WorkspaceSafetyDecision): GitLabError {
  return new GitLabError(
    "configuration",
    `Workspace release is blocked: ${decision.blockers.map(({ message }) => message).join(" ")}`,
  );
}

async function exists(candidate: string): Promise<boolean> {
  try {
    await access(candidate, constants.F_OK);
    return true;
  } catch (error) {
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      error.code === "ENOENT"
    ) {
      return false;
    }
    throw error;
  }
}

async function measureTree(
  candidate: string,
  signal?: AbortSignal,
): Promise<number> {
  throwIfAborted(signal);
  const candidateStat = await lstat(candidate);
  if (!candidateStat.isDirectory()) return candidateStat.size;
  let total = candidateStat.size;
  const directory = await opendir(candidate);
  try {
    for await (const entry of directory) {
      throwIfAborted(signal);
      const child = path.join(candidate, entry.name);
      const childStat = await lstat(child);
      total += childStat.isDirectory()
        ? await measureTree(child, signal)
        : childStat.size;
    }
  } finally {
    await directory.close().catch(() => undefined);
  }
  return total;
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted === true) {
    throw new GitLabError("cancelled", "Workspace operation cancelled.");
  }
}
