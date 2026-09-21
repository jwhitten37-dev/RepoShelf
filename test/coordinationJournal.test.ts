import path from "node:path";
import {
  link,
  mkdtemp,
  mkdir,
  readdir,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import {
  CoordinationJournal,
  CoordinationJournalError,
} from "../src/infrastructure/coordinationJournal.js";
import {
  CoordinationRecordError,
  parseDetachmentAcknowledgement,
  parseReleaseClaim,
  parseReleaseCancellation,
  parseReleaseOutcome,
  parseReleaseRequest,
  parseSessionDescriptor,
  parseSessionLease,
  type DetachmentAcknowledgement,
  type ReleaseClaim,
  type ReleaseCancellation,
  type ReleaseOutcome,
  type ReleaseRequest,
  type SessionDescriptor,
  type SessionLease,
} from "../src/infrastructure/coordinationRecords.js";

const WORKSPACE_ID = "11111111-1111-4111-8111-111111111111";
const OPERATION_ID = "22222222-2222-4222-8222-222222222222";
const REQUEST_NONCE = "33333333-3333-4333-8333-333333333333";
const INSTANCE_ID = "44444444-4444-4444-8444-444444444444";
const COORDINATOR_ID = "55555555-5555-4555-8555-555555555555";
const MANAGED_ID = "66666666-6666-4666-8666-666666666666";
const DETACHED_ID = "77777777-7777-4777-8777-777777777777";
const CLAIMANT_ID = "88888888-8888-4888-8888-888888888888";
const BOOT_NONCE = "99999999-9999-4999-8999-999999999999";
const INTENT_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const HEAD_SHA = "b".repeat(40);
const temporaryRoots: string[] = [];

const descriptor: SessionDescriptor = {
  schemaVersion: 1,
  recordType: "sessionDescriptor",
  sessionId: COORDINATOR_ID,
  role: "coordinator",
  createdAt: 1_000,
  environmentFingerprint: "c".repeat(64),
  extensionVersion: "0.1.0",
  bootNonce: BOOT_NONCE,
};

const lease: SessionLease = {
  schemaVersion: 1,
  recordType: "sessionLease",
  sessionId: COORDINATOR_ID,
  bootNonce: BOOT_NONCE,
  role: "coordinator",
  sequence: 1,
  observedAt: 1_000,
  expiresAt: 31_000,
};

const request: ReleaseRequest = {
  schemaVersion: 1,
  recordType: "releaseRequest",
  workspaceId: WORKSPACE_ID,
  operationId: OPERATION_ID,
  requestNonce: REQUEST_NONCE,
  operationKind: "release",
  instanceId: INSTANCE_ID,
  projectId: 42,
  canonicalRepositoryUrl: "https://gitlab.example.test/group/project",
  targetBranch: "feature/test",
  canonicalLocalPath: path.resolve("managed", "workspace"),
  canonicalCloneRoot: path.resolve("managed"),
  expectedHeadSha: HEAD_SHA,
  coordinatorSessionId: COORDINATOR_ID,
  managedSessionId: MANAGED_ID,
  confirmationAt: 900,
  createdAt: 1_000,
  expiresAt: 121_000,
};

const detachment: DetachmentAcknowledgement = {
  schemaVersion: 1,
  recordType: "detachmentAcknowledgement",
  ...operationBinding(request),
  detachedSessionId: DETACHED_ID,
  detachedAt: 2_000,
  consumedIntentId: INTENT_ID,
};

const claim: ReleaseClaim = {
  schemaVersion: 1,
  recordType: "releaseClaim",
  ...operationBinding(request),
  claimantSessionId: CLAIMANT_ID,
  claimantBootNonce: BOOT_NONCE,
  claimantRole: "coordinator",
  claimedAt: 3_000,
};

const outcome: ReleaseOutcome = {
  schemaVersion: 1,
  recordType: "releaseOutcome",
  workspaceId: WORKSPACE_ID,
  operationId: OPERATION_ID,
  requestNonce: REQUEST_NONCE,
  claimantSessionId: CLAIMANT_ID,
  outcome: "completed",
  deletionVerified: true,
  registryReconciliation: "succeeded",
  catalogRefresh: "failed",
  createdAt: 4_000,
  diagnosticCode: "CATALOG_REFRESH_FAILED",
};

const cancellation: ReleaseCancellation = {
  schemaVersion: 1,
  recordType: "releaseCancellation",
  workspaceId: WORKSPACE_ID,
  operationId: OPERATION_ID,
  requestNonce: REQUEST_NONCE,
  cancellingSessionId: MANAGED_ID,
  cancellingBootNonce: BOOT_NONCE,
  cancelledAt: 1_500,
};

afterEach(async () => {
  await Promise.all(
    temporaryRoots
      .splice(0)
      .map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("coordination record validation", () => {
  it("round-trips every Phase 4.1B-1 record schema", () => {
    expect(parseSessionDescriptor(descriptor)).toEqual(descriptor);
    expect(parseSessionLease(lease)).toEqual(lease);
    expect(parseReleaseRequest(request)).toEqual(request);
    expect(parseDetachmentAcknowledgement(detachment)).toEqual(detachment);
    expect(parseReleaseClaim(claim)).toEqual(claim);
    expect(parseReleaseCancellation(cancellation)).toEqual(cancellation);
    expect(parseReleaseOutcome(outcome)).toEqual(outcome);
  });

  it("publishes only an exact managed-host pre-claim cancellation", async () => {
    const journal = await createJournal();
    const managed: SessionDescriptor = {
      ...descriptor,
      sessionId: MANAGED_ID,
      role: "managed",
    };
    await journal.publishSessionDescriptor(managed);
    await journal.publishRequest(request);

    await journal.publishCancellation(cancellation);

    await expect(
      journal.readCancellation(WORKSPACE_ID, OPERATION_ID),
    ).resolves.toEqual(cancellation);
    await expect(
      journal.publishCancellation({
        ...cancellation,
        operationId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      }),
    ).rejects.toMatchObject({ code: "invalidRecord" });
  });

  it("rejects unknown properties, versions, UUIDs, SHA values, and time order", () => {
    expect(() => parseReleaseRequest({ ...request, unexpected: true })).toThrow(
      CoordinationRecordError,
    );
    expect(() => parseReleaseRequest({ ...request, schemaVersion: 2 })).toThrow(
      CoordinationRecordError,
    );
    expect(() =>
      parseReleaseRequest({ ...request, workspaceId: "../escape" }),
    ).toThrow(CoordinationRecordError);
    expect(() =>
      parseReleaseRequest({ ...request, expectedHeadSha: "A".repeat(40) }),
    ).toThrow(CoordinationRecordError);
    expect(() =>
      parseReleaseRequest({ ...request, expiresAt: request.createdAt }),
    ).toThrow(CoordinationRecordError);
    expect(() =>
      parseSessionLease({ ...lease, expiresAt: lease.observedAt + 120_001 }),
    ).toThrow(CoordinationRecordError);
    expect(() =>
      parseReleaseRequest({
        ...request,
        canonicalRepositoryUrl:
          "https://user:secret@gitlab.example.test/group/project",
      }),
    ).toThrow(CoordinationRecordError);
    expect(() =>
      parseReleaseRequest({
        ...request,
        canonicalLocalPath: request.canonicalCloneRoot,
      }),
    ).toThrow(CoordinationRecordError);
  });

  it("rejects inconsistent outcomes and unbounded nested input", () => {
    expect(() =>
      parseReleaseOutcome({ ...outcome, deletionVerified: false }),
    ).toThrow(CoordinationRecordError);
    expect(() =>
      parseReleaseOutcome({
        ...outcome,
        outcome: "blocked",
        deletionVerified: false,
        registryReconciliation: "succeeded",
        catalogRefresh: "notAttempted",
      }),
    ).toThrow(CoordinationRecordError);
    expect(() =>
      parseReleaseRequest({
        ...request,
        extra: { one: { two: { three: { four: "too deep" } } } },
      }),
    ).toThrow(CoordinationRecordError);
  });
});

describe("CoordinationJournal", () => {
  it("publishes and reads immutable session and operation records", async () => {
    const journal = await createJournal();

    await journal.publishSessionDescriptor(descriptor);
    await journal.publishRequest(request);
    await journal.publishDetachment(detachment);
    expect(await journal.claim(claim)).toBe("claimed");
    await journal.publishOutcome(outcome);

    await expect(
      journal.readSessionDescriptor(COORDINATOR_ID),
    ).resolves.toEqual(descriptor);
    await expect(
      journal.readRequest(WORKSPACE_ID, OPERATION_ID),
    ).resolves.toEqual(request);
    await expect(
      journal.readDetachment(WORKSPACE_ID, OPERATION_ID),
    ).resolves.toEqual(detachment);
    await expect(
      journal.readClaim(WORKSPACE_ID, OPERATION_ID),
    ).resolves.toEqual(claim);
    await expect(
      journal.readOutcome(WORKSPACE_ID, OPERATION_ID),
    ).resolves.toEqual(outcome);
  });

  it("never replaces an immutable record", async () => {
    const journal = await createJournal();
    await journal.publishRequest(request);

    await expect(journal.publishRequest(request)).rejects.toMatchObject({
      code: "recordExists",
    });
    await expect(
      journal.readRequest(WORKSPACE_ID, OPERATION_ID),
    ).resolves.toEqual(request);
    const files = await readdir(
      path.join(
        journal.root,
        "workspaces",
        WORKSPACE_ID,
        "operations",
        OPERATION_ID,
      ),
    );
    expect(files.filter((file) => file.endsWith(".tmp"))).toEqual([]);
  });

  it("atomically replaces leases and treats malformed leases as absent", async () => {
    const journal = await createJournal();
    await journal.publishSessionDescriptor(descriptor);
    await journal.writeLease(lease);
    const replacement = {
      ...lease,
      sequence: 2,
      observedAt: 2_000,
      expiresAt: 32_000,
    } satisfies SessionLease;

    await journal.writeLease(replacement);
    await expect(journal.readLease(COORDINATOR_ID)).resolves.toEqual(
      replacement,
    );

    await writeFile(
      path.join(journal.root, "sessions", COORDINATOR_ID, "lease.json"),
      "not json",
    );
    await expect(journal.readLease(COORDINATOR_ID)).resolves.toBeUndefined();
  });

  it("requires immutable session identity and rejects lease regression", async () => {
    const journal = await createJournal();
    await expect(journal.writeLease(lease)).rejects.toMatchObject({
      code: "invalidRecord",
    });
    await journal.publishSessionDescriptor(descriptor);
    await expect(
      journal.writeLease({ ...lease, bootNonce: INTENT_ID }),
    ).rejects.toMatchObject({ code: "invalidRecord" });
    await journal.writeLease(lease);
    await expect(
      journal.writeLease({ ...lease, sequence: 0, observedAt: 2_000 }),
    ).rejects.toMatchObject({ code: "invalidRecord" });
    await expect(
      journal.writeLease({ ...lease, sequence: 2, observedAt: 999 }),
    ).rejects.toMatchObject({ code: "invalidRecord" });
    await expect(journal.readLease(COORDINATOR_ID)).resolves.toEqual(lease);
  });

  it("allows exactly one winner across many journal instances", async () => {
    const journal = await createJournal();
    await journal.publishRequest(request);
    await journal.publishDetachment(detachment);
    const attempts = Array.from({ length: 200 }, (_, index) => {
      const contender = new CoordinationJournal(path.dirname(journal.root));
      return contender.claim({
        ...claim,
        claimantSessionId: uuidFor(index + 1),
      });
    });

    const results = await Promise.all(attempts);

    expect(results.filter((result) => result === "claimed")).toHaveLength(1);
    expect(
      results.filter((result) => result === "alreadyClaimed"),
    ).toHaveLength(199);
    const winningClaim = await journal.readClaim(WORKSPACE_ID, OPERATION_ID);
    expect(winningClaim?.workspaceId).toBe(WORKSPACE_ID);
    expect(winningClaim?.operationId).toBe(OPERATION_ID);
  });

  it("claims independent workspace operations without cross-talk", async () => {
    const journal = await createJournal();
    const otherWorkspace = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
    const otherOperation = "ffffffff-ffff-4fff-8fff-ffffffffffff";
    const otherRequest = {
      ...request,
      workspaceId: otherWorkspace,
      operationId: otherOperation,
      requestNonce: uuidFor(300),
      canonicalLocalPath: path.join(
        request.canonicalCloneRoot,
        "other-workspace",
      ),
    } satisfies ReleaseRequest;
    const otherDetachment = {
      ...detachment,
      ...operationBinding(otherRequest),
    } satisfies DetachmentAcknowledgement;
    const otherClaim = {
      ...claim,
      ...operationBinding(otherRequest),
      claimantSessionId: uuidFor(301),
    } satisfies ReleaseClaim;
    await Promise.all([
      journal.publishRequest(request),
      journal.publishRequest(otherRequest),
    ]);
    await Promise.all([
      journal.publishDetachment(detachment),
      journal.publishDetachment(otherDetachment),
    ]);

    await expect(
      Promise.all([journal.claim(claim), journal.claim(otherClaim)]),
    ).resolves.toEqual(["claimed", "claimed"]);
    await expect(
      journal.readClaim(WORKSPACE_ID, OPERATION_ID),
    ).resolves.toEqual(claim);
    await expect(
      journal.readClaim(otherWorkspace, otherOperation),
    ).resolves.toEqual(otherClaim);
  });

  it("does not steal or repair an incomplete claim directory", async () => {
    const journal = await createJournal();
    await journal.publishRequest(request);
    await journal.publishDetachment(detachment);
    await mkdir(
      path.join(
        journal.root,
        "workspaces",
        WORKSPACE_ID,
        "operations",
        OPERATION_ID,
        "claim",
      ),
    );

    await expect(journal.claim(claim)).resolves.toBe("alreadyClaimed");
    await expect(
      journal.readClaim(WORKSPACE_ID, OPERATION_ID),
    ).rejects.toMatchObject({ code: "poisonedClaim" });
  });

  it("rejects path traversal and records bound to another operation path", async () => {
    const journal = await createJournal();
    await expect(
      journal.readRequest("../escape", OPERATION_ID),
    ).rejects.toMatchObject({ code: "invalidRecord" });

    const otherOperation = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
    const operationDirectory = path.join(
      journal.root,
      "workspaces",
      WORKSPACE_ID,
      "operations",
      otherOperation,
    );
    await mkdir(operationDirectory, { recursive: true });
    await writeFile(
      path.join(operationDirectory, "request.json"),
      JSON.stringify(request),
    );

    await expect(
      journal.readRequest(WORKSPACE_ID, otherOperation),
    ).rejects.toMatchObject({ code: "invalidRecord" });
  });

  it("rejects skipped transitions and conflicting cross-record identities", async () => {
    const journal = await createJournal();
    await expect(journal.publishDetachment(detachment)).rejects.toMatchObject({
      code: "invalidRecord",
    });
    await journal.publishRequest(request);
    await expect(journal.claim(claim)).rejects.toMatchObject({
      code: "invalidRecord",
    });
    await expect(
      journal.publishDetachment({
        ...detachment,
        expectedHeadSha: "d".repeat(40),
      }),
    ).rejects.toMatchObject({ code: "invalidRecord" });
    await journal.publishDetachment(detachment);
    await expect(
      journal.claim({ ...claim, targetBranch: "other" }),
    ).rejects.toMatchObject({ code: "invalidRecord" });
    await expect(journal.publishOutcome(outcome)).rejects.toMatchObject({
      code: "invalidRecord",
    });
  });

  it("rejects an outcome bound to a different claimant", async () => {
    const journal = await createJournal();
    await journal.publishRequest(request);
    await journal.publishDetachment(detachment);
    await journal.claim(claim);

    await expect(
      journal.publishOutcome({
        ...outcome,
        claimantSessionId: COORDINATOR_ID,
      }),
    ).rejects.toMatchObject({ code: "invalidRecord" });
  });

  it("rejects detachment, claim, and outcome time inconsistencies", async () => {
    const journal = await createJournal();
    await journal.publishRequest(request);
    await expect(
      journal.publishDetachment({
        ...detachment,
        detachedAt: request.expiresAt + 1,
      }),
    ).rejects.toMatchObject({ code: "invalidRecord" });
    await journal.publishDetachment(detachment);
    await expect(
      journal.claim({ ...claim, claimedAt: detachment.detachedAt - 1 }),
    ).rejects.toMatchObject({ code: "invalidRecord" });
    await journal.claim(claim);
    await expect(
      journal.publishOutcome({ ...outcome, createdAt: claim.claimedAt - 1 }),
    ).rejects.toMatchObject({ code: "invalidRecord" });
  });

  it("rejects oversized published records before parsing", async () => {
    const journal = await createJournal();
    const operationDirectory = path.join(
      journal.root,
      "workspaces",
      WORKSPACE_ID,
      "operations",
      OPERATION_ID,
    );
    await mkdir(operationDirectory, { recursive: true });
    await writeFile(
      path.join(operationDirectory, "request.json"),
      "x".repeat(33 * 1_024),
    );

    await expect(
      journal.readRequest(WORKSPACE_ID, OPERATION_ID),
    ).rejects.toMatchObject({ code: "invalidRecord" });
  });

  it("ignores abandoned temporary files and rejects invalid UTF-8", async () => {
    const journal = await createJournal();
    const operationDirectory = path.join(
      journal.root,
      "workspaces",
      WORKSPACE_ID,
      "operations",
      OPERATION_ID,
    );
    await mkdir(operationDirectory, { recursive: true });
    await writeFile(
      path.join(operationDirectory, ".request.json.abandoned.tmp"),
      JSON.stringify(request),
    );
    await expect(
      journal.readRequest(WORKSPACE_ID, OPERATION_ID),
    ).resolves.toBeUndefined();

    await writeFile(
      path.join(operationDirectory, "request.json"),
      Buffer.from([0xff, 0xfe]),
    );
    await expect(
      journal.readRequest(WORKSPACE_ID, OPERATION_ID),
    ).rejects.toMatchObject({ code: "invalidRecord" });
  });

  it("rejects a journal rooted through a symbolic link", async () => {
    const root = await temporaryRoot();
    const target = path.join(root, "target");
    const linked = path.join(root, "linked");
    await mkdir(target);
    await symlink(target, linked, directoryLinkType());
    const journal = new CoordinationJournal(linked);

    await expect(journal.initialize()).rejects.toMatchObject({
      code: "unsafeStorage",
    });
  });

  it.skipIf(process.platform === "win32")(
    "distinguishes an unsafe lease link from an absent malformed lease",
    async () => {
      const journal = await createJournal();
      await journal.publishSessionDescriptor(descriptor);
      const outside = path.join(await temporaryRoot(), "outside.json");
      await writeFile(outside, JSON.stringify(lease));
      await symlink(
        outside,
        path.join(journal.root, "sessions", COORDINATOR_ID, "lease.json"),
        "file",
      );

      await expect(journal.readLease(COORDINATOR_ID)).rejects.toMatchObject({
        code: "unsafeStorage",
      });
    },
  );

  it("rejects an immutable record with another hard-link name", async () => {
    const journal = await createJournal();
    await journal.publishRequest(request);
    const requestFile = path.join(
      journal.root,
      "workspaces",
      WORKSPACE_ID,
      "operations",
      OPERATION_ID,
      "request.json",
    );
    await link(requestFile, path.join(await temporaryRoot(), "alias.json"));

    await expect(
      journal.readRequest(WORKSPACE_ID, OPERATION_ID),
    ).rejects.toMatchObject({ code: "unsafeStorage" });
  });

  it("uses generic errors that do not expose record contents", async () => {
    const journal = await createJournal();
    const sensitive = "https://user:secret@example.test/private?token=value";

    let failure: unknown;
    try {
      await journal.publishRequest({
        ...request,
        canonicalRepositoryUrl: sensitive,
        unknown: sensitive,
      } as ReleaseRequest);
    } catch (error) {
      failure = error;
    }

    expect(failure).toBeInstanceOf(CoordinationJournalError);
    expect(String(failure)).not.toContain("secret");
    expect(String(failure)).not.toContain("token");
    expect(String(failure)).not.toContain("private");
  });
});

function directoryLinkType(): "dir" | "junction" {
  return process.platform === "win32" ? "junction" : "dir";
}

async function createJournal(): Promise<CoordinationJournal> {
  const root = await temporaryRoot();
  const journal = new CoordinationJournal(root);
  await journal.initialize();
  return journal;
}

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "reposhelf-coordination-"));
  temporaryRoots.push(root);
  return root;
}

function operationBinding(value: ReleaseRequest) {
  return {
    workspaceId: value.workspaceId,
    operationId: value.operationId,
    requestNonce: value.requestNonce,
    operationKind: value.operationKind,
    instanceId: value.instanceId,
    projectId: value.projectId,
    canonicalRepositoryUrl: value.canonicalRepositoryUrl,
    targetBranch: value.targetBranch,
    canonicalLocalPath: value.canonicalLocalPath,
    canonicalCloneRoot: value.canonicalCloneRoot,
    expectedHeadSha: value.expectedHeadSha,
    coordinatorSessionId: value.coordinatorSessionId,
    managedSessionId: value.managedSessionId,
  };
}

function uuidFor(value: number): string {
  return `00000000-0000-4000-8000-${value.toString(16).padStart(12, "0")}`;
}
