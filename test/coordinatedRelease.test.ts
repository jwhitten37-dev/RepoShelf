import path from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import type { ManagedWorkspaceRecord } from "../src/domain/models.js";
import {
  CoordinatedReleaseExecutor,
  type CoordinatedReleaseRegistry,
  type CoordinatedReleaseSafetyService,
} from "../src/infrastructure/coordinatedRelease.js";
import { CoordinationJournal } from "../src/infrastructure/coordinationJournal.js";
import { CoordinationProjection } from "../src/infrastructure/coordinationProjection.js";
import type {
  DetachmentAcknowledgement,
  MaterializationHandoff,
  ReleaseClaim,
  ReleaseRequest,
  SessionDescriptor,
  SessionLease,
} from "../src/infrastructure/coordinationRecords.js";
import type {
  DeletionCapability,
  VerifiedWorkspaceAbsence,
} from "../src/infrastructure/workspaceRelease.js";

const roots: string[] = [];
const WORKSPACE_ID = uuid(1);
const OPERATION_ID = uuid(2);
const COORDINATOR_ID = uuid(3);
const MANAGED_ID = uuid(4);
const DETACHED_ID = uuid(5);
const FINGERPRINT = "a".repeat(64);

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("CoordinatedReleaseExecutor", () => {
  it("requires all evidence, deletes once, reconciles, and completes", async () => {
    const fixture = await createFixture();

    const result = await fixture.executor.execute(
      fixture.location,
      fixture.coordinator,
    );

    expect(result.outcome).toMatchObject({
      outcome: "completed",
      deletionVerified: true,
      registryReconciliation: "succeeded",
      catalogRefresh: "succeeded",
    });
    expect(fixture.release.prepared).toBe(1);
    expect(fixture.release.deleted).toBe(1);
    expect(fixture.release.requireExactRemote).toBe(false);
    expect(fixture.registry.records).toEqual([]);
  });

  it("binds push-and-release to exact post-push proof", async () => {
    const fixture = await createFixture("pushAndRelease");

    await fixture.executor.execute(fixture.location, fixture.coordinator);

    expect(fixture.release.requireExactRemote).toBe(true);
  });

  it("blocks before capability minting for unsaved buffers or forged claimant", async () => {
    const fixture = await createFixture("release", 1);
    const blocked = await fixture.executor.execute(
      fixture.location,
      fixture.coordinator,
    );

    expect(blocked.outcome).toMatchObject({
      outcome: "blocked",
      diagnosticCode: "UNSAVED_BUFFERS",
    });
    expect(fixture.release.prepared).toBe(0);
    expect(fixture.release.deleted).toBe(0);

    const forgedFixture = await createFixture();
    const forged = await forgedFixture.executor.execute(
      forgedFixture.location,
      {
        ...forgedFixture.coordinator,
        bootNonce: uuid(99),
      },
    );
    expect(forged.outcome).toMatchObject({
      outcome: "blocked",
      diagnosticCode: "PROTOCOL_INVALID",
    });
    expect(forgedFixture.release.deleted).toBe(0);
  });

  it("retains data and metadata when deletion cannot establish absence", async () => {
    const fixture = await createFixture();
    fixture.release.deleteError = new Error("simulated failure");

    const result = await fixture.executor.execute(
      fixture.location,
      fixture.coordinator,
    );

    expect(result.outcome).toMatchObject({
      outcome: "failedRetained",
      deletionVerified: false,
      registryReconciliation: "notAttempted",
    });
    expect(fixture.registry.records).toEqual([fixture.record]);
  });

  it("completes after a deletion exception only when fresh absence is proven", async () => {
    const fixture = await createFixture();
    fixture.release.deleteError = new Error("crash after removal");
    fixture.absent.value = true;
    fixture.registry.failRemoval = true;
    fixture.catalog.fail = true;

    const result = await fixture.executor.execute(
      fixture.location,
      fixture.coordinator,
    );

    expect(result.outcome).toMatchObject({
      outcome: "completed",
      deletionVerified: true,
      registryReconciliation: "failed",
      catalogRefresh: "failed",
    });
  });

  it("recovers abandoned claims without claiming or deleting", async () => {
    const retained = await createFixture("release", 0, 40_000);
    const interrupted = await retained.executor.recover(retained.location);
    expect(interrupted?.outcome).toMatchObject({
      outcome: "interrupted",
      diagnosticCode: "CLAIMANT_INTERRUPTED",
    });
    expect(retained.release.deleted).toBe(0);
    expect(retained.registry.records).toEqual([retained.record]);

    const absent = await createFixture("release", 0, 40_000);
    absent.absent.value = true;
    const completed = await absent.executor.recover(absent.location);
    expect(completed?.outcome).toMatchObject({
      outcome: "completed",
      diagnosticCode: "RECOVERED_ABSENCE",
    });
    expect(absent.release.deleted).toBe(0);
    expect(absent.registry.records).toEqual([]);
  });

  it("does not recover a claimant with a live lease", async () => {
    const fixture = await createFixture();

    await expect(
      fixture.executor.recover(fixture.location),
    ).resolves.toBeUndefined();
    expect(fixture.release.deleted).toBe(0);
  });

  it("observes exact-claimant cancellation before capability minting", async () => {
    const fixture = await createFixture();
    await fixture.journal.publishCancellation({
      schemaVersion: 1,
      recordType: "releaseCancellation",
      workspaceId: WORKSPACE_ID,
      operationId: OPERATION_ID,
      requestNonce: uuid(6),
      cancellingSessionId: fixture.coordinator.sessionId,
      cancellingBootNonce: fixture.coordinator.bootNonce,
      cancelledAt: 2_750,
    });

    const result = await fixture.executor.execute(
      fixture.location,
      fixture.coordinator,
    );
    expect(result.outcome).toMatchObject({
      outcome: "blocked",
      diagnosticCode: "CANCELLED",
    });
    expect(fixture.release.prepared).toBe(0);
    expect(fixture.release.deleted).toBe(0);
  });

  it("retains after cancellation wins the immediate pre-delete guard", async () => {
    const fixture = await createFixture();
    fixture.release.runFinalAuthorization = true;
    fixture.release.finalAuthorizationResult = false;

    const result = await fixture.executor.execute(
      fixture.location,
      fixture.coordinator,
    );

    expect(result.outcome).toMatchObject({ outcome: "failedRetained" });
    expect(fixture.registry.records).toEqual([fixture.record]);
  });
});

class FakeRelease implements CoordinatedReleaseSafetyService {
  public prepared = 0;
  public deleted = 0;
  public requireExactRemote: boolean | undefined;
  public finalAuthorization: (() => Promise<boolean>) | undefined;
  public runFinalAuthorization = true;
  public finalAuthorizationResult = true;
  public deleteError: unknown;
  private readonly capability = {
    workspaceId: WORKSPACE_ID,
    canonicalPath: path.resolve("managed", "workspace"),
  } satisfies DeletionCapability;
  private readonly proof = {
    workspaceId: WORKSPACE_ID,
    canonicalPath: path.resolve("managed", "workspace"),
  } satisfies VerifiedWorkspaceAbsence;

  public prepareDeletion(
    _record: ManagedWorkspaceRecord,
    _expectedHeadSha: string,
    _unsavedEditorCount: number,
    _signal?: AbortSignal,
    requireExactRemote?: boolean,
    finalAuthorization?: () => Promise<boolean>,
  ): Promise<DeletionCapability> {
    this.prepared += 1;
    this.requireExactRemote = requireExactRemote;
    this.finalAuthorization = finalAuthorization;
    return Promise.resolve(this.capability);
  }

  public async deleteFilesystem(
    capability: DeletionCapability,
    unsavedEditorCount: number,
  ): Promise<VerifiedWorkspaceAbsence> {
    expect(capability).toBe(this.capability);
    expect(unsavedEditorCount).toBeGreaterThanOrEqual(0);
    this.deleted += 1;
    if (this.runFinalAuthorization) {
      expect(this.finalAuthorization).toBeDefined();
      if (
        !(await this.finalAuthorization?.()) ||
        !this.finalAuthorizationResult
      ) {
        throw new Error("cancelled before removal");
      }
    }
    if (this.deleteError !== undefined) {
      throw this.deleteError instanceof Error
        ? this.deleteError
        : new Error("simulated deletion failure");
    }
    return this.proof;
  }

  public consumeAbsenceProof(
    proof: VerifiedWorkspaceAbsence,
    expected: ManagedWorkspaceRecord,
  ): void {
    if (proof !== this.proof || expected.workspaceId !== proof.workspaceId) {
      throw new Error("invalid proof");
    }
  }
}

class FakeRegistry implements CoordinatedReleaseRegistry {
  public failRemoval = false;

  public constructor(public records: ManagedWorkspaceRecord[]) {}

  public list(): readonly ManagedWorkspaceRecord[] {
    return this.records;
  }

  public removeVerified(record: ManagedWorkspaceRecord): Promise<void> {
    if (this.failRemoval) return Promise.reject(new Error("registry failure"));
    this.records = this.records.filter(
      (candidate) => candidate.workspaceId !== record.workspaceId,
    );
    return Promise.resolve();
  }

  public reload(): Promise<void> {
    return Promise.resolve();
  }
}

async function createFixture(
  operationKind: ReleaseRequest["operationKind"] = "release",
  unsavedBuffers = 0,
  now = 3_000,
) {
  const root = await mkdtemp(path.join(tmpdir(), "reposhelf-executor-test-"));
  roots.push(root);
  const journal = new CoordinationJournal(root);
  const coordinator = descriptor("coordinator", COORDINATOR_ID, uuid(13));
  const managed = descriptor("managed", MANAGED_ID, uuid(14));
  const detached = descriptor("detached", DETACHED_ID, uuid(15));
  await journal.publishSessionDescriptor(coordinator);
  await journal.publishSessionDescriptor(managed);
  await journal.publishSessionDescriptor(detached);
  await journal.writeLease(lease(coordinator, 31_000));
  const request = makeRequest(operationKind);
  const handoff: MaterializationHandoff = {
    schemaVersion: 1,
    recordType: "materializationHandoff",
    workspaceId: WORKSPACE_ID,
    canonicalLocalPath: request.canonicalLocalPath,
    coordinatorSessionId: COORDINATOR_ID,
    managedSessionId: MANAGED_ID,
    environmentFingerprint: FINGERPRINT,
    extensionVersion: "0.1.0",
    createdAt: 500,
    expiresAt: 30_500,
  };
  await journal.publishMaterializationHandoff(handoff);
  await journal.publishRequest(request);
  await journal.publishDetachment(detachment(request));
  await journal.claim(claim(request, coordinator));
  const record = makeRecord();
  const release = new FakeRelease();
  const registry = new FakeRegistry([record]);
  const absent = { value: false };
  const catalog = { fail: false };
  const executor = new CoordinatedReleaseExecutor(
    journal,
    new CoordinationProjection(journal),
    release,
    registry,
    () => unsavedBuffers,
    () => {
      if (catalog.fail) throw new Error("catalog failure");
    },
    () => now,
    () => 1_000,
    () => Promise.resolve(absent.value),
    () => Promise.resolve(true),
  );
  return {
    journal,
    coordinator,
    record,
    release,
    registry,
    absent,
    catalog,
    executor,
    location: { workspaceId: WORKSPACE_ID, operationId: OPERATION_ID },
  };
}

function descriptor(
  role: SessionDescriptor["role"],
  sessionId: string,
  bootNonce: string,
): SessionDescriptor {
  return {
    schemaVersion: 1,
    recordType: "sessionDescriptor",
    sessionId,
    role,
    createdAt: 100,
    environmentFingerprint: FINGERPRINT,
    extensionVersion: "0.1.0",
    bootNonce,
  };
}

function lease(descriptor: SessionDescriptor, expiresAt: number): SessionLease {
  return {
    schemaVersion: 1,
    recordType: "sessionLease",
    sessionId: descriptor.sessionId,
    bootNonce: descriptor.bootNonce,
    role: descriptor.role,
    sequence: 1,
    observedAt: 1_000,
    expiresAt,
  };
}

function makeRequest(
  operationKind: ReleaseRequest["operationKind"],
): ReleaseRequest {
  return {
    schemaVersion: 1,
    recordType: "releaseRequest",
    workspaceId: WORKSPACE_ID,
    operationId: OPERATION_ID,
    requestNonce: uuid(6),
    operationKind,
    instanceId: uuid(7),
    projectId: 42,
    canonicalRepositoryUrl: "https://gitlab.example.test/group/project",
    targetBranch: "main",
    canonicalLocalPath: path.resolve("managed", "workspace"),
    canonicalCloneRoot: path.resolve("managed"),
    expectedHeadSha: "b".repeat(40),
    coordinatorSessionId: COORDINATOR_ID,
    managedSessionId: MANAGED_ID,
    confirmationAt: 800,
    createdAt: 1_000,
    expiresAt: 121_000,
  };
}

function detachment(request: ReleaseRequest): DetachmentAcknowledgement {
  return {
    schemaVersion: 1,
    recordType: "detachmentAcknowledgement",
    ...binding(request),
    detachedSessionId: DETACHED_ID,
    detachedAt: 2_000,
    consumedIntentId: uuid(8),
  };
}

function claim(
  request: ReleaseRequest,
  claimant: SessionDescriptor,
): ReleaseClaim {
  return {
    schemaVersion: 1,
    recordType: "releaseClaim",
    ...binding(request),
    claimantSessionId: claimant.sessionId,
    claimantBootNonce: claimant.bootNonce,
    claimantRole: "coordinator",
    claimedAt: 2_500,
  };
}

function binding(request: ReleaseRequest) {
  return {
    workspaceId: request.workspaceId,
    operationId: request.operationId,
    requestNonce: request.requestNonce,
    operationKind: request.operationKind,
    instanceId: request.instanceId,
    projectId: request.projectId,
    canonicalRepositoryUrl: request.canonicalRepositoryUrl,
    targetBranch: request.targetBranch,
    canonicalLocalPath: request.canonicalLocalPath,
    canonicalCloneRoot: request.canonicalCloneRoot,
    expectedHeadSha: request.expectedHeadSha,
    coordinatorSessionId: request.coordinatorSessionId,
    managedSessionId: request.managedSessionId,
  };
}

function makeRecord(): ManagedWorkspaceRecord {
  return {
    schemaVersion: 1,
    workspaceId: WORKSPACE_ID,
    instanceId: uuid(7),
    projectId: 42,
    projectPath: "group/project",
    canonicalRepositoryUrl: "https://gitlab.example.test/group/project",
    targetBranch: "main",
    pinnedCommitSha: "b".repeat(40),
    cloneMode: "full",
    sparseDirectories: [],
    localPath: path.resolve("managed", "workspace"),
    cloneRoot: path.resolve("managed"),
    revealPath: undefined,
    createdAt: new Date(0).toISOString(),
    lastOpenedAt: new Date(0).toISOString(),
  };
}

function uuid(value: number): string {
  return `${value.toString(16).padStart(8, "0")}-0000-4000-8000-000000000000`;
}
