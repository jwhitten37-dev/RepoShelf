import { execFile } from "node:child_process";
import path from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { promisify } from "node:util";
import { build } from "esbuild";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CoordinationJournal } from "../src/infrastructure/coordinationJournal.js";
import type {
  DetachmentAcknowledgement,
  ReleaseClaim,
  ReleaseRequest,
} from "../src/infrastructure/coordinationRecords.js";

const run = promisify(execFile);
let buildRoot: string;
let worker: string;
const roots: string[] = [];

beforeAll(async () => {
  buildRoot = await mkdtemp(path.join(tmpdir(), "reposhelf-worker-build-"));
  worker = path.join(buildRoot, "claim-worker.mjs");
  await build({
    entryPoints: [
      path.resolve("test", "fixtures", "coordinationClaimWorker.ts"),
    ],
    outfile: worker,
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node24",
  });
});

afterAll(async () => {
  await Promise.all(
    [buildRoot, ...roots].map((root) =>
      rm(root, { recursive: true, force: true }),
    ),
  );
});

describe("independent coordination claim processes", () => {
  it("elects exactly one claimant across independent Node processes", async () => {
    for (let batch = 0; batch < 4; batch += 1) {
      const { root, journal, request } = await setup(batch + 1);
      const attempts = await Promise.all(
        Array.from({ length: 50 }, (_, index) =>
          invoke(
            root,
            makeClaim(
              request,
              uuid(batch * 50 + index + 20),
              index % 2 === 0 ? "coordinator" : "detached",
            ),
          ),
        ),
      );

      expect(
        attempts.filter(({ stdout }) => stdout === "claimed"),
      ).toHaveLength(1);
      expect(
        attempts.filter(({ stdout }) => stdout === "alreadyClaimed"),
      ).toHaveLength(49);
      await expect(
        journal.readClaim(request.workspaceId, request.operationId),
      ).resolves.toBeDefined();
    }
  });

  it("does not steal a claim when a worker crashes before publication", async () => {
    const { root, journal, request } = await setup();
    const claim = makeClaim(request, uuid(99));

    await expect(
      invoke(root, claim, "crashAfterClaimDirectory"),
    ).rejects.toMatchObject({ code: 91 });
    await expect(invoke(root, makeClaim(request, uuid(100)))).resolves.toEqual({
      stdout: "alreadyClaimed",
      stderr: "",
    });
    await expect(
      journal.readClaim(request.workspaceId, request.operationId),
    ).rejects.toMatchObject({ code: "poisonedClaim" });
  });
});

async function setup(identity = 1): Promise<{
  root: string;
  journal: CoordinationJournal;
  request: ReleaseRequest;
}> {
  const root = await mkdtemp(path.join(tmpdir(), "reposhelf-process-test-"));
  roots.push(root);
  const journal = new CoordinationJournal(root);
  const request = makeRequest(identity);
  await journal.publishRequest(request);
  await journal.publishDetachment(makeDetachment(request));
  return { root, journal, request };
}

async function invoke(
  root: string,
  claim: ReleaseClaim,
  mode = "claim",
): Promise<{ stdout: string; stderr: string }> {
  return run(process.execPath, [worker, root, mode, JSON.stringify(claim)]);
}

function makeRequest(identity = 1): ReleaseRequest {
  return {
    schemaVersion: 1,
    recordType: "releaseRequest",
    workspaceId: uuid(identity * 10 + 1),
    operationId: uuid(identity * 10 + 2),
    requestNonce: uuid(identity * 10 + 3),
    operationKind: "release",
    instanceId: uuid(4),
    projectId: 42,
    canonicalRepositoryUrl: "https://gitlab.example.test/group/project",
    targetBranch: "feature/test",
    canonicalLocalPath: path.resolve("managed", "workspace"),
    canonicalCloneRoot: path.resolve("managed"),
    expectedHeadSha: "a".repeat(40),
    coordinatorSessionId: uuid(5),
    managedSessionId: uuid(6),
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
    detachedSessionId: uuid(7),
    detachedAt: 2_000,
    consumedIntentId: uuid(8),
  };
}

function makeClaim(
  request: ReleaseRequest,
  claimant: string,
  claimantRole: ReleaseClaim["claimantRole"] = "coordinator",
): ReleaseClaim {
  return {
    schemaVersion: 1,
    recordType: "releaseClaim",
    ...binding(request),
    claimantSessionId: claimant,
    claimantBootNonce: uuid(200),
    claimantRole,
    claimedAt: 3_000,
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

function uuid(value: number): string {
  return `${value.toString(16).padStart(8, "0")}-0000-4000-8000-000000000000`;
}
