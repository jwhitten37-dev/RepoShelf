import path from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { CoordinationClaimArbiter } from "../src/infrastructure/coordinationArbitration.js";
import { CoordinationJournal } from "../src/infrastructure/coordinationJournal.js";
import type {
  DetachmentAcknowledgement,
  ReleaseRequest,
  SessionDescriptor,
  SessionLease,
} from "../src/infrastructure/coordinationRecords.js";

const temporaryRoots: string[] = [];
const FINGERPRINT = "a".repeat(64);
const COORDINATOR_ID = uuid(1);
const MANAGED_ID = uuid(2);
const DETACHED_ID = uuid(3);
const WORKSPACE_ID = uuid(4);
const OPERATION_ID = uuid(5);

afterEach(async () => {
  await Promise.all(
    temporaryRoots
      .splice(0)
      .map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("CoordinationClaimArbiter", () => {
  it("gives a live compatible coordinator the bounded preferred opportunity", async () => {
    const journal = await setupJournal();
    const request = makeRequest();
    await journal.publishRequest(request);
    await journal.publishDetachment(makeDetachment(request));

    const arbiter = new CoordinationClaimArbiter(journal, () => 2_500);
    await expect(
      arbiter.attemptClaim(request, descriptor("detached", DETACHED_ID)),
    ).resolves.toBe("coordinatorPreferred");
    await expect(
      arbiter.attemptClaim(request, descriptor("coordinator", COORDINATOR_ID)),
    ).resolves.toBe("claimed");
  });

  it("allows fallback after preference and never steals the resulting claim", async () => {
    const journal = await setupJournal();
    const request = makeRequest();
    await journal.publishRequest(request);
    await journal.publishDetachment(makeDetachment(request));
    const arbiter = new CoordinationClaimArbiter(journal, () => 7_001);

    await expect(
      arbiter.attemptClaim(request, descriptor("detached", DETACHED_ID)),
    ).resolves.toBe("claimed");
    await expect(
      arbiter.attemptClaim(request, descriptor("coordinator", COORDINATOR_ID)),
    ).resolves.toBe("observing");
  });

  it("rejects missing detachment, expiry, managed claimants, and upgrades", async () => {
    const journal = await setupJournal();
    const request = makeRequest();
    const arbiter = new CoordinationClaimArbiter(journal, () => 2_500);
    await journal.publishRequest(request);
    await expect(
      arbiter.attemptClaim(request, descriptor("detached", DETACHED_ID)),
    ).resolves.toBe("notDetached");
    await journal.publishDetachment(makeDetachment(request));

    await expect(
      arbiter.attemptClaim(request, descriptor("managed", MANAGED_ID)),
    ).resolves.toBe("incompatibleSession");
    await expect(
      arbiter.attemptClaim(request, descriptor("coordinator", uuid(90))),
    ).resolves.toBe("incompatibleSession");
    await expect(
      arbiter.attemptClaim(request, descriptor("detached", uuid(91))),
    ).resolves.toBe("incompatibleSession");
    await expect(
      arbiter.attemptClaim(request, {
        ...descriptor("detached", DETACHED_ID),
        extensionVersion: "0.2.0",
      }),
    ).resolves.toBe("incompatibleSession");
    await expect(
      new CoordinationClaimArbiter(journal, () => 121_001).attemptClaim(
        request,
        descriptor("detached", DETACHED_ID),
      ),
    ).resolves.toBe("requestExpired");
  });

  it("observes a managed-host cancellation without creating a claim", async () => {
    const journal = await setupJournal();
    const request = makeRequest();
    const managed = descriptor("managed", MANAGED_ID);
    await journal.publishRequest(request);
    await journal.publishDetachment(makeDetachment(request));
    await journal.publishCancellation({
      schemaVersion: 1,
      recordType: "releaseCancellation",
      workspaceId: request.workspaceId,
      operationId: request.operationId,
      requestNonce: request.requestNonce,
      cancellingSessionId: managed.sessionId,
      cancellingBootNonce: managed.bootNonce,
      cancelledAt: 2_250,
    });

    const arbiter = new CoordinationClaimArbiter(journal, () => 2_500);
    await expect(
      arbiter.attemptClaim(request, descriptor("coordinator", COORDINATOR_ID)),
    ).resolves.toBe("observing");
    await expect(
      journal.readClaim(request.workspaceId, request.operationId),
    ).resolves.toBeUndefined();
  });

  it("does not treat detachment as authority while the managed lease is live", async () => {
    const journal = await setupJournal();
    const request = makeRequest();
    const managed = descriptor("managed", MANAGED_ID);
    await journal.writeLease({
      schemaVersion: 1,
      recordType: "sessionLease",
      sessionId: managed.sessionId,
      bootNonce: managed.bootNonce,
      role: managed.role,
      sequence: 1,
      observedAt: 1_500,
      expiresAt: 31_500,
    });
    await journal.publishRequest(request);
    await journal.publishDetachment(makeDetachment(request));

    await expect(
      new CoordinationClaimArbiter(journal, () => 2_500).attemptClaim(
        request,
        descriptor("coordinator", COORDINATOR_ID),
      ),
    ).resolves.toBe("incompatibleSession");
    await expect(
      journal.readClaim(request.workspaceId, request.operationId),
    ).resolves.toBeUndefined();
  });
});

async function setupJournal(): Promise<CoordinationJournal> {
  const root = await mkdtemp(path.join(tmpdir(), "reposhelf-arbiter-test-"));
  temporaryRoots.push(root);
  const journal = new CoordinationJournal(root);
  await journal.initialize();
  const coordinator = descriptor("coordinator", COORDINATOR_ID);
  const detached = descriptor("detached", DETACHED_ID);
  const managed = descriptor("managed", MANAGED_ID);
  await journal.publishSessionDescriptor(coordinator);
  await journal.publishSessionDescriptor(detached);
  await journal.publishSessionDescriptor(managed);
  await journal.writeLease({
    schemaVersion: 1,
    recordType: "sessionLease",
    sessionId: COORDINATOR_ID,
    bootNonce: coordinator.bootNonce,
    role: "coordinator",
    sequence: 1,
    observedAt: 1_000,
    expiresAt: 31_000,
  } satisfies SessionLease);
  await journal.writeLease({
    schemaVersion: 1,
    recordType: "sessionLease",
    sessionId: DETACHED_ID,
    bootNonce: detached.bootNonce,
    role: "detached",
    sequence: 1,
    observedAt: 2_000,
    expiresAt: 32_000,
  } satisfies SessionLease);
  return journal;
}

function descriptor(
  role: SessionDescriptor["role"],
  sessionId: string,
): SessionDescriptor {
  return {
    schemaVersion: 1,
    recordType: "sessionDescriptor",
    sessionId,
    role,
    createdAt: 1_000,
    environmentFingerprint: FINGERPRINT,
    extensionVersion: "0.1.0",
    bootNonce: uuid(Number.parseInt(sessionId.slice(0, 8), 16) + 20),
  };
}

function makeRequest(): ReleaseRequest {
  return {
    schemaVersion: 1,
    recordType: "releaseRequest",
    workspaceId: WORKSPACE_ID,
    operationId: OPERATION_ID,
    requestNonce: uuid(6),
    operationKind: "release",
    instanceId: uuid(7),
    projectId: 42,
    canonicalRepositoryUrl: "https://gitlab.example.test/group/project",
    targetBranch: "feature/test",
    canonicalLocalPath: path.resolve("managed", "workspace"),
    canonicalCloneRoot: path.resolve("managed"),
    expectedHeadSha: "b".repeat(40),
    coordinatorSessionId: COORDINATOR_ID,
    managedSessionId: MANAGED_ID,
    confirmationAt: 900,
    createdAt: 1_000,
    expiresAt: 121_000,
  };
}

function makeDetachment(request: ReleaseRequest): DetachmentAcknowledgement {
  return {
    schemaVersion: 1,
    recordType: "detachmentAcknowledgement",
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
    detachedSessionId: DETACHED_ID,
    detachedAt: 2_000,
    consumedIntentId: uuid(8),
  };
}

function uuid(value: number): string {
  return `${value.toString(16).padStart(8, "0")}-0000-4000-8000-000000000000`;
}
