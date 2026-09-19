import path from "node:path";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { CoordinationJournal } from "../src/infrastructure/coordinationJournal.js";
import { CoordinationProjection } from "../src/infrastructure/coordinationProjection.js";
import type {
  DetachmentAcknowledgement,
  ReleaseClaim,
  ReleaseOutcome,
  ReleaseRequest,
} from "../src/infrastructure/coordinationRecords.js";

const temporaryRoots: string[] = [];
const WORKSPACE_ID = uuid(1);
const OPERATION_ID = uuid(2);
const REQUEST_NONCE = uuid(3);
const COORDINATOR_ID = uuid(4);
const MANAGED_ID = uuid(5);
const DETACHED_ID = uuid(6);
const CLAIMANT_ID = uuid(7);
const BOOT_NONCE = uuid(8);

afterEach(async () => {
  await Promise.all(
    temporaryRoots
      .splice(0)
      .map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("CoordinationProjection", () => {
  it("projects each ordered operation state without side effects", async () => {
    const { journal, projection } = await createProjection();
    const request = makeRequest(WORKSPACE_ID, OPERATION_ID, REQUEST_NONCE);
    await journal.publishRequest(request);
    await expect(projection.projectAll()).resolves.toMatchObject([
      {
        workspaceId: WORKSPACE_ID,
        operationId: OPERATION_ID,
        state: "requested",
      },
    ]);

    await journal.publishDetachment(makeDetachment(request));
    await expect(projection.projectAll()).resolves.toMatchObject([
      { state: "detached" },
    ]);

    await journal.claim(makeClaim(request));
    await expect(projection.projectAll()).resolves.toMatchObject([
      { state: "claimed", claim: { claimantSessionId: CLAIMANT_ID } },
    ]);

    await journal.publishOutcome(makeOutcome(request, "completed"));
    await expect(projection.projectAll()).resolves.toMatchObject([
      { state: "completed", outcome: { deletionVerified: true } },
    ]);
  });

  it.each([
    ["blocked", false],
    ["failedRetained", false],
    ["interrupted", false],
  ] as const)("projects the %s terminal outcome", async (state, deleted) => {
    const { journal, projection } = await createProjection();
    const request = makeRequest(WORKSPACE_ID, OPERATION_ID, REQUEST_NONCE);
    await journal.publishRequest(request);
    await journal.publishDetachment(makeDetachment(request));
    await journal.claim(makeClaim(request));
    await journal.publishOutcome(makeOutcome(request, state));

    await expect(projection.projectAll()).resolves.toMatchObject([
      { state, outcome: { deletionVerified: deleted } },
    ]);
  });

  it("blocks unclaimed cancellation but lets verified absence win after claim", async () => {
    const { journal, projection } = await createProjection();
    await journal.publishSessionDescriptor({
      schemaVersion: 1,
      recordType: "sessionDescriptor",
      sessionId: MANAGED_ID,
      role: "managed",
      createdAt: 500,
      environmentFingerprint: "a".repeat(64),
      extensionVersion: "0.1.0",
      bootNonce: BOOT_NONCE,
    });
    await journal.publishSessionDescriptor({
      schemaVersion: 1,
      recordType: "sessionDescriptor",
      sessionId: CLAIMANT_ID,
      role: "coordinator",
      createdAt: 500,
      environmentFingerprint: "a".repeat(64),
      extensionVersion: "0.1.0",
      bootNonce: BOOT_NONCE,
    });
    const request = makeRequest(WORKSPACE_ID, OPERATION_ID, REQUEST_NONCE);
    await journal.publishRequest(request);
    await journal.publishCancellation({
      schemaVersion: 1,
      recordType: "releaseCancellation",
      workspaceId: request.workspaceId,
      operationId: request.operationId,
      requestNonce: request.requestNonce,
      cancellingSessionId: MANAGED_ID,
      cancellingBootNonce: BOOT_NONCE,
      cancelledAt: 1_500,
    });
    await expect(projection.projectAll()).resolves.toMatchObject([
      { state: "blocked", cancellation: { cancelledAt: 1_500 } },
    ]);

    const claimedRequest = makeRequest(WORKSPACE_ID, uuid(90), uuid(91));
    await journal.publishRequest(claimedRequest);
    await journal.publishDetachment(makeDetachment(claimedRequest));
    await journal.claim(makeClaim(claimedRequest));
    await journal.publishCancellation({
      schemaVersion: 1,
      recordType: "releaseCancellation",
      workspaceId: claimedRequest.workspaceId,
      operationId: claimedRequest.operationId,
      requestNonce: claimedRequest.requestNonce,
      cancellingSessionId: CLAIMANT_ID,
      cancellingBootNonce: BOOT_NONCE,
      cancelledAt: 3_500,
    });
    await expect(
      projection.project({
        workspaceId: claimedRequest.workspaceId,
        operationId: claimedRequest.operationId,
      }),
    ).resolves.toMatchObject({ state: "claimed", cancellation: {} });
    await journal.publishOutcome(makeOutcome(claimedRequest, "completed"));

    await expect(
      projection.project({
        workspaceId: claimedRequest.workspaceId,
        operationId: claimedRequest.operationId,
      }),
    ).resolves.toMatchObject({
      state: "completed",
      outcome: { deletionVerified: true },
      cancellation: {},
    });
  });

  it("poisons multiple active operations in one workspace", async () => {
    const { journal, projection } = await createProjection();
    await journal.publishRequest(
      makeRequest(WORKSPACE_ID, OPERATION_ID, REQUEST_NONCE),
    );
    await journal.publishRequest(makeRequest(WORKSPACE_ID, uuid(9), uuid(10)));

    const operations = await projection.projectAll();

    expect(operations).toHaveLength(2);
    expect(operations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          state: "poisoned",
          diagnosticCode: "DUPLICATE_ACTIVE_OPERATION",
        }),
        expect.objectContaining({
          state: "poisoned",
          diagnosticCode: "DUPLICATE_ACTIVE_OPERATION",
        }),
      ]),
    );
  });

  it("keeps active operations in different workspaces isolated", async () => {
    const { journal, projection } = await createProjection();
    await journal.publishRequest(
      makeRequest(WORKSPACE_ID, OPERATION_ID, REQUEST_NONCE),
    );
    await journal.publishRequest(makeRequest(uuid(11), uuid(12), uuid(13), 2));

    await expect(projection.projectAll()).resolves.toMatchObject([
      { state: "requested" },
      { state: "requested" },
    ]);
  });

  it("poisons missing requests, malformed records, and unexpected artifacts", async () => {
    const { journal, projection } = await createProjection();
    const missingRequestOperation = operationDirectory(
      journal,
      WORKSPACE_ID,
      OPERATION_ID,
    );
    await mkdir(missingRequestOperation, { recursive: true });
    const malformedOperation = operationDirectory(journal, uuid(14), uuid(15));
    await mkdir(malformedOperation, { recursive: true });
    await writeFile(path.join(malformedOperation, "request.json"), "not-json");
    const unexpectedOperation = operationDirectory(journal, uuid(16), uuid(17));
    await mkdir(unexpectedOperation, { recursive: true });
    await writeFile(
      path.join(unexpectedOperation, "surprise.txt"),
      "unexpected",
    );

    const operations = await projection.projectAll();

    expect(operations).toHaveLength(3);
    expect(operations.every(({ state }) => state === "poisoned")).toBe(true);
    expect(operations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ diagnosticCode: "UNEXPECTED_ARTIFACT" }),
        expect.objectContaining({ diagnosticCode: "INVALID_OPERATION" }),
      ]),
    );
  });

  it("ignores abandoned temporary files but validates claim directory contents", async () => {
    const { journal, projection } = await createProjection();
    const request = makeRequest(WORKSPACE_ID, OPERATION_ID, REQUEST_NONCE);
    await journal.publishRequest(request);
    const directory = operationDirectory(journal, WORKSPACE_ID, OPERATION_ID);
    await writeFile(
      path.join(
        directory,
        ".request.json.aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa.tmp",
      ),
      "partial",
    );
    await expect(projection.projectAll()).resolves.toMatchObject([
      { state: "requested" },
    ]);

    await journal.publishDetachment(makeDetachment(request));
    await journal.claim(makeClaim(request));
    await writeFile(path.join(directory, "claim", "unexpected.txt"), "bad");
    await expect(projection.projectAll()).resolves.toMatchObject([
      { state: "poisoned", diagnosticCode: "UNEXPECTED_ARTIFACT" },
    ]);
  });

  it("fails the entire bounded scan instead of silently truncating", async () => {
    const { journal, projection } = await createProjection();
    const workspaces = path.join(journal.root, "workspaces");
    await Promise.all(
      Array.from({ length: 257 }, (_, index) =>
        mkdir(path.join(workspaces, uuid(index + 100)), { recursive: true }),
      ),
    );

    await expect(projection.projectAll()).rejects.toMatchObject({
      code: "unsafeStorage",
    });
  });

  it("fails closed on unexpected workspace-level artifacts", async () => {
    const { journal, projection } = await createProjection();
    await journal.publishRequest(
      makeRequest(WORKSPACE_ID, OPERATION_ID, REQUEST_NONCE),
    );
    await writeFile(
      path.join(journal.root, "workspaces", WORKSPACE_ID, "unexpected.json"),
      "{}",
    );

    await expect(projection.projectAll()).rejects.toMatchObject({
      code: "unsafeStorage",
    });
  });
});

async function createProjection(): Promise<{
  journal: CoordinationJournal;
  projection: CoordinationProjection;
}> {
  const root = await mkdtemp(path.join(tmpdir(), "reposhelf-projection-"));
  temporaryRoots.push(root);
  const journal = new CoordinationJournal(root);
  await journal.initialize();
  return { journal, projection: new CoordinationProjection(journal) };
}

function makeRequest(
  workspaceId: string,
  operationId: string,
  requestNonce: string,
  projectId = 1,
): ReleaseRequest {
  const cloneRoot = path.resolve("managed", workspaceId);
  return {
    schemaVersion: 1,
    recordType: "releaseRequest",
    workspaceId,
    operationId,
    requestNonce,
    operationKind: "release",
    instanceId: uuid(500),
    projectId,
    canonicalRepositoryUrl: `https://gitlab.example.test/group/project-${projectId}`,
    targetBranch: "main",
    canonicalLocalPath: path.join(cloneRoot, "checkout"),
    canonicalCloneRoot: cloneRoot,
    expectedHeadSha: "a".repeat(40),
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
    ...binding(request),
    detachedSessionId: DETACHED_ID,
    detachedAt: 2_000,
    consumedIntentId: uuid(501),
  };
}

function makeClaim(request: ReleaseRequest): ReleaseClaim {
  return {
    schemaVersion: 1,
    recordType: "releaseClaim",
    ...binding(request),
    claimantSessionId: CLAIMANT_ID,
    claimantBootNonce: BOOT_NONCE,
    claimantRole: "coordinator",
    claimedAt: 3_000,
  };
}

function makeOutcome(
  request: ReleaseRequest,
  state: ReleaseOutcome["outcome"],
): ReleaseOutcome {
  const completed = state === "completed";
  return {
    schemaVersion: 1,
    recordType: "releaseOutcome",
    workspaceId: request.workspaceId,
    operationId: request.operationId,
    requestNonce: request.requestNonce,
    claimantSessionId: CLAIMANT_ID,
    outcome: state,
    deletionVerified: completed,
    registryReconciliation: completed ? "succeeded" : "notAttempted",
    catalogRefresh: completed ? "succeeded" : "notAttempted",
    createdAt: 4_000,
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

function operationDirectory(
  journal: CoordinationJournal,
  workspaceId: string,
  operationId: string,
): string {
  return path.join(
    journal.root,
    "workspaces",
    workspaceId,
    "operations",
    operationId,
  );
}

function uuid(value: number): string {
  return `00000000-0000-4000-8000-${value.toString(16).padStart(12, "0")}`;
}
