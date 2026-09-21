import { constants } from "node:fs";
import { access } from "node:fs/promises";
import path from "node:path";
import { GitLabError } from "../domain/errors.js";
import type { ManagedWorkspaceRecord } from "../domain/models.js";
import type { CoordinationJournal } from "./coordinationJournal.js";
import type { CoordinationProjection } from "./coordinationProjection.js";
import type {
  ReleaseClaim,
  ReleaseOutcome,
  ReleaseRequest,
  SessionDescriptor,
} from "./coordinationRecords.js";
import type {
  DeletionCapability,
  VerifiedWorkspaceAbsence,
} from "./workspaceRelease.js";

const PROCESSING_DEADLINE_MS = 30_000;

export interface CoordinatedReleaseRegistry {
  list(): readonly ManagedWorkspaceRecord[];
  removeVerified(record: ManagedWorkspaceRecord): Promise<void>;
  reload(): Promise<void>;
}

export interface CoordinatedReleaseSafetyService {
  prepareDeletion(
    record: ManagedWorkspaceRecord,
    expectedHeadSha: string,
    unsavedEditorCount: number,
    signal?: AbortSignal,
    requireExactRemote?: boolean,
    finalAuthorization?: () => Promise<boolean>,
  ): Promise<DeletionCapability>;
  deleteFilesystem(
    capability: DeletionCapability,
    unsavedEditorCount: number,
  ): Promise<VerifiedWorkspaceAbsence>;
  consumeAbsenceProof(
    proof: VerifiedWorkspaceAbsence,
    expected: ManagedWorkspaceRecord,
  ): void;
}

export interface CoordinatedReleaseLocation {
  readonly workspaceId: string;
  readonly operationId: string;
}

export interface CoordinatedExecutionResult {
  readonly outcome: ReleaseOutcome;
  readonly record?: ManagedWorkspaceRecord;
}

export class CoordinatedReleaseExecutor {
  public constructor(
    private readonly journal: CoordinationJournal,
    private readonly projection: CoordinationProjection,
    private readonly release: CoordinatedReleaseSafetyService,
    private readonly registry: CoordinatedReleaseRegistry,
    private readonly countUnsavedBuffers: (canonicalPath: string) => number,
    private readonly refreshCatalog: (target: {
      readonly instanceId: string;
      readonly projectId: number;
      readonly targetBranch: string;
    }) => Promise<void>,
    private readonly now: () => number = Date.now,
    private readonly monotonicNow: () => number = () => performance.now(),
    private readonly isAbsent: (
      canonicalPath: string,
    ) => Promise<boolean> = filesystemAbsent,
    private readonly canDeclareAbandoned: (
      claim: ReleaseClaim,
    ) => Promise<boolean> = () => Promise.resolve(false),
  ) {}

  public async execute(
    location: CoordinatedReleaseLocation,
    claimant: SessionDescriptor,
    signal?: AbortSignal,
  ): Promise<CoordinatedExecutionResult> {
    const started = this.monotonicNow();
    await this.registry.reload();
    const state = await this.projection.project(location);
    if (
      state.state !== "claimed" ||
      state.request === undefined ||
      state.claim === undefined
    ) {
      throw new CoordinatedReleaseError(
        "PROTOCOL_INVALID",
        "Coordinated release requires one valid claimed operation.",
      );
    }
    const { request, claim } = state;
    const record = this.findRecord(request);
    if (record === undefined) {
      const outcome = await this.publishRetained(
        request,
        claim,
        "blocked",
        "REGISTRY_MISMATCH",
      );
      return { outcome };
    }
    let deletionStarted = false;
    try {
      await this.validateAuthorization(request, claim, claimant, record);
      this.assertDeadline(started);
      const capability = await this.release.prepareDeletion(
        record,
        request.expectedHeadSha,
        this.countUnsavedBuffers(record.localPath),
        signal,
        request.operationKind === "pushAndRelease",
        () =>
          this.finalAuthorization(request, claim, claimant, record, started),
      );
      this.assertDeadline(started);
      deletionStarted = true;
      const proof = await this.release.deleteFilesystem(
        capability,
        this.countUnsavedBuffers(record.localPath),
      );
      this.assertDeadline(started);
      this.release.consumeAbsenceProof(proof, record);
      return await this.complete(request, claim, record);
    } catch (error) {
      if (deletionStarted && (await this.isAbsent(record.localPath))) {
        return this.complete(request, claim, record);
      }
      const outcome = await this.publishRetained(
        request,
        claim,
        deletionStarted ? "failedRetained" : "blocked",
        diagnosticCode(error),
      );
      return { outcome, record };
    }
  }

  public async recover(
    location: CoordinatedReleaseLocation,
  ): Promise<CoordinatedExecutionResult | undefined> {
    await this.registry.reload();
    const state = await this.projection.project(location);
    if (
      state.state !== "claimed" ||
      state.request === undefined ||
      state.claim === undefined
    ) {
      return undefined;
    }
    const claimant = await this.journal.readSessionDescriptor(
      state.claim.claimantSessionId,
    );
    if (
      claimant !== undefined &&
      (await this.hasLiveLease(claimant, this.now()))
    ) {
      return undefined;
    }
    const record = this.findRecord(state.request);
    if (await this.isAbsent(state.request.canonicalLocalPath)) {
      if (record === undefined) {
        const outcome = await this.publishCompleted(
          state.request,
          state.claim,
          "failed",
          await this.refreshCatalogSafely(state.request),
          "RECOVERED_ABSENCE",
        );
        return { outcome };
      }
      return this.complete(
        state.request,
        state.claim,
        record,
        "RECOVERED_ABSENCE",
      );
    }
    if (!(await this.canDeclareAbandoned(state.claim))) return undefined;
    const outcome = await this.publishRetained(
      state.request,
      state.claim,
      "interrupted",
      "CLAIMANT_INTERRUPTED",
    );
    return record === undefined ? { outcome } : { outcome, record };
  }

  private async validateAuthorization(
    request: ReleaseRequest,
    claim: ReleaseClaim,
    claimant: SessionDescriptor,
    record: ManagedWorkspaceRecord,
  ): Promise<void> {
    const now = this.now();
    if (
      claim.claimantSessionId !== claimant.sessionId ||
      claim.claimantBootNonce !== claimant.bootNonce ||
      claim.claimantRole !== claimant.role
    ) {
      throw protocolError();
    }
    const published = await this.journal.readSessionDescriptor(
      claimant.sessionId,
    );
    if (
      !sameSession(published, claimant) ||
      !(await this.hasLiveLease(claimant, now))
    ) {
      throw protocolError();
    }
    const detachment = await this.journal.readDetachment(
      request.workspaceId,
      request.operationId,
    );
    if (detachment === undefined || detachment.detachedAt > claim.claimedAt) {
      throw protocolError();
    }
    if (!(await this.isNotCancelled(request))) {
      throw new CoordinatedReleaseError(
        "CANCELLED",
        "Coordinated release was cancelled.",
      );
    }
    const coordinator = await this.journal.readSessionDescriptor(
      request.coordinatorSessionId,
    );
    const managed = await this.journal.readSessionDescriptor(
      request.managedSessionId,
    );
    const detached = await this.journal.readSessionDescriptor(
      detachment.detachedSessionId,
    );
    if (
      coordinator === undefined ||
      managed === undefined ||
      detached === undefined ||
      coordinator.role !== "coordinator" ||
      managed.role !== "managed" ||
      detached.role !== "detached" ||
      coordinator.environmentFingerprint !== claimant.environmentFingerprint ||
      managed.environmentFingerprint !== claimant.environmentFingerprint ||
      detached.environmentFingerprint !== claimant.environmentFingerprint ||
      coordinator.extensionVersion !== claimant.extensionVersion ||
      managed.extensionVersion !== claimant.extensionVersion ||
      detached.extensionVersion !== claimant.extensionVersion ||
      (await this.hasLiveLease(managed, now))
    ) {
      throw protocolError();
    }
    for (const handoff of await this.journal.readMaterializationHandoffs(
      request.workspaceId,
    )) {
      if (handoff.managedSessionId === request.managedSessionId) continue;
      const other = await this.journal.readSessionDescriptor(
        handoff.managedSessionId,
      );
      if (other?.role === "managed" && (await this.hasLiveLease(other, now))) {
        throw new CoordinatedReleaseError(
          "CONFLICTING_MANAGED_SESSION",
          "Another managed session is active for this workspace.",
        );
      }
    }
    if (!recordMatchesRequest(record, request)) throw protocolError();
    if (this.countUnsavedBuffers(record.localPath) > 0) {
      throw new CoordinatedReleaseError(
        "UNSAVED_BUFFERS",
        "Associated unsaved buffers block coordinated release.",
      );
    }
  }

  private findRecord(
    request: ReleaseRequest,
  ): ManagedWorkspaceRecord | undefined {
    return this.registry
      .list()
      .find((candidate) => candidate.workspaceId === request.workspaceId);
  }

  private assertDeadline(started: number): void {
    const elapsed = this.monotonicNow() - started;
    if (elapsed < 0 || elapsed > PROCESSING_DEADLINE_MS) {
      throw new CoordinatedReleaseError(
        "PROCESSING_DEADLINE",
        "Coordinated release processing exceeded its monotonic deadline.",
      );
    }
  }

  private async complete(
    request: ReleaseRequest,
    claim: ReleaseClaim,
    record: ManagedWorkspaceRecord,
    code?: string,
  ): Promise<CoordinatedExecutionResult> {
    let registryReconciliation: "succeeded" | "failed" = "succeeded";
    try {
      await this.registry.removeVerified(record);
    } catch {
      registryReconciliation = "failed";
    }
    const outcome = await this.publishCompleted(
      request,
      claim,
      registryReconciliation,
      await this.refreshCatalogSafely(record),
      code,
    );
    return { outcome, record };
  }

  private async refreshCatalogSafely(
    record: Pick<
      ManagedWorkspaceRecord,
      "instanceId" | "projectId" | "targetBranch"
    >,
  ): Promise<"succeeded" | "failed"> {
    try {
      await this.refreshCatalog({
        instanceId: record.instanceId,
        projectId: record.projectId,
        targetBranch: record.targetBranch,
      });
      return "succeeded";
    } catch {
      return "failed";
    }
  }

  private async publishCompleted(
    request: ReleaseRequest,
    claim: ReleaseClaim,
    registryReconciliation: "succeeded" | "failed",
    catalogRefresh: "succeeded" | "failed",
    diagnosticCode?: string,
  ): Promise<ReleaseOutcome> {
    const outcome: ReleaseOutcome = {
      schemaVersion: 1,
      recordType: "releaseOutcome",
      workspaceId: request.workspaceId,
      operationId: request.operationId,
      requestNonce: request.requestNonce,
      claimantSessionId: claim.claimantSessionId,
      outcome: "completed",
      deletionVerified: true,
      registryReconciliation,
      catalogRefresh,
      createdAt: Math.max(this.now(), claim.claimedAt),
      ...(diagnosticCode === undefined ? {} : { diagnosticCode }),
    };
    await this.journal.publishOutcome(outcome);
    return outcome;
  }

  private async publishRetained(
    request: ReleaseRequest,
    claim: ReleaseClaim,
    outcomeKind: "blocked" | "failedRetained" | "interrupted",
    code: string,
  ): Promise<ReleaseOutcome> {
    const outcome: ReleaseOutcome = {
      schemaVersion: 1,
      recordType: "releaseOutcome",
      workspaceId: request.workspaceId,
      operationId: request.operationId,
      requestNonce: request.requestNonce,
      claimantSessionId: claim.claimantSessionId,
      outcome: outcomeKind,
      deletionVerified: false,
      registryReconciliation: "notAttempted",
      catalogRefresh: "notAttempted",
      createdAt: Math.max(this.now(), claim.claimedAt),
      diagnosticCode: code,
    };
    await this.journal.publishOutcome(outcome);
    return outcome;
  }

  private async hasLiveLease(
    descriptor: SessionDescriptor,
    now: number,
  ): Promise<boolean> {
    const lease = await this.journal.readLease(descriptor.sessionId);
    return (
      lease !== undefined &&
      lease.bootNonce === descriptor.bootNonce &&
      lease.role === descriptor.role &&
      lease.observedAt <= now &&
      lease.expiresAt >= now
    );
  }

  private async isNotCancelled(request: ReleaseRequest): Promise<boolean> {
    return (
      (await this.journal.readCancellation(
        request.workspaceId,
        request.operationId,
      )) === undefined
    );
  }

  private async finalAuthorization(
    request: ReleaseRequest,
    claim: ReleaseClaim,
    claimant: SessionDescriptor,
    record: ManagedWorkspaceRecord,
    started: number,
  ): Promise<boolean> {
    this.assertDeadline(started);
    await this.registry.reload();
    const current = this.findRecord(request);
    if (current === undefined || !sameManagedRecord(current, record))
      return false;
    try {
      await this.validateAuthorization(request, claim, claimant, current);
      this.assertDeadline(started);
      return true;
    } catch {
      return false;
    }
  }
}

export class CoordinatedReleaseError extends Error {
  public constructor(
    public readonly diagnosticCode: string,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, { cause: options?.cause });
    this.name = "CoordinatedReleaseError";
  }
}

function protocolError(): CoordinatedReleaseError {
  return new CoordinatedReleaseError(
    "PROTOCOL_INVALID",
    "Distributed release authorization is invalid or incomplete.",
  );
}

function diagnosticCode(error: unknown): string {
  if (error instanceof CoordinatedReleaseError) return error.diagnosticCode;
  if (error instanceof GitLabError) {
    if (error.code === "cancelled") return "CANCELLED";
    if (error.code === "timeout") return "SAFETY_TIMEOUT";
    if (error.code === "network") return "REMOTE_UNAVAILABLE";
    return "SAFETY_BLOCKED";
  }
  return "RELEASE_FAILED";
}

function sameSession(
  published: SessionDescriptor | undefined,
  actual: SessionDescriptor,
): boolean {
  return (
    published !== undefined &&
    published.sessionId === actual.sessionId &&
    published.bootNonce === actual.bootNonce &&
    published.role === actual.role &&
    published.environmentFingerprint === actual.environmentFingerprint &&
    published.extensionVersion === actual.extensionVersion
  );
}

function recordMatchesRequest(
  record: ManagedWorkspaceRecord,
  request: ReleaseRequest,
): boolean {
  return (
    record.workspaceId === request.workspaceId &&
    record.instanceId === request.instanceId &&
    record.projectId === request.projectId &&
    record.canonicalRepositoryUrl === request.canonicalRepositoryUrl &&
    record.targetBranch === request.targetBranch &&
    samePath(record.localPath, request.canonicalLocalPath) &&
    samePath(record.cloneRoot, request.canonicalCloneRoot)
  );
}

function sameManagedRecord(
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
    left.lastOpenedAt === right.lastOpenedAt &&
    left.lastVerifiedAt === right.lastVerifiedAt &&
    left.lastPushedCommitSha === right.lastPushedCommitSha
  );
}

async function filesystemAbsent(candidate: string): Promise<boolean> {
  try {
    await access(candidate, constants.F_OK);
    return false;
  } catch (error) {
    if (hasCode(error, "ENOENT")) return true;
    return false;
  }
}

function hasCode(error: unknown, code: string): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === code
  );
}

function samePath(left: string, right: string): boolean {
  return process.platform === "win32"
    ? path.resolve(left).localeCompare(path.resolve(right), undefined, {
        sensitivity: "accent",
      }) === 0
    : path.resolve(left) === path.resolve(right);
}
