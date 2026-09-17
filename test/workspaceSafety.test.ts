import { describe, expect, it } from "vitest";
import type { GitSafetySnapshot } from "../src/domain/workspaceSafety.js";
import {
  decidePostPushSafety,
  decidePushReadiness,
  decideWorkspaceSafety,
} from "../src/domain/workspaceSafety.js";
import {
  parseAheadBehind,
  parsePorcelainV2Z,
} from "../src/infrastructure/workspaceSafety.js";

describe("workspace safety decision", () => {
  it("allows only complete clean evidence with remote reachability", () => {
    expect(
      decideWorkspaceSafety({
        ownershipValid: true,
        unsavedEditorCount: 0,
        expectedBranch: "main",
        expectedOriginUrl: "https://gitlab.example.test/group/project",
        snapshot: safeSnapshot(),
      }),
    ).toEqual({ safe: true, blockers: [] });
  });

  it("fails closed when the snapshot is missing", () => {
    const decision = decideWorkspaceSafety({
      ownershipValid: false,
      unsavedEditorCount: 1,
      expectedBranch: "main",
      expectedOriginUrl: "https://gitlab.example.test/group/project",
      snapshot: undefined,
    });

    expect(decision.safe).toBe(false);
    expect(decision.blockers.map(({ code }) => code)).toEqual([
      "ownership",
      "unsavedEditors",
      "snapshotIncomplete",
    ]);
  });

  it("reports every independent Git blocker", () => {
    const decision = decideWorkspaceSafety({
      ownershipValid: true,
      unsavedEditorCount: 2,
      expectedBranch: "main",
      expectedOriginUrl: "https://gitlab.example.test/group/project",
      snapshot: {
        ...safeSnapshot(),
        statusEntryCount: 3,
        operationStates: ["rebase"],
        branch: "other",
        originUrl: "https://gitlab.example.test/other/project",
        remoteTargetSha: undefined,
        headAheadOfRemoteTarget: undefined,
        localOnlyRefCount: 1,
      },
    });

    expect(decision.blockers.map(({ code }) => code)).toEqual([
      "unsavedEditors",
      "dirtyGit",
      "gitOperation",
      "branchMismatch",
      "originMismatch",
      "remoteTargetMissing",
      "localOnlyRefs",
    ]);
  });

  it("blocks a local HEAD commit not reachable from the intended remote", () => {
    const decision = decideWorkspaceSafety({
      ownershipValid: true,
      unsavedEditorCount: 0,
      expectedBranch: "main",
      expectedOriginUrl: "https://gitlab.example.test/group/project",
      snapshot: { ...safeSnapshot(), headAheadOfRemoteTarget: 1 },
    });

    expect(decision.blockers.map(({ code }) => code)).toEqual([
      "headNotRemote",
    ]);
  });

  it("allows clean committed work to proceed to push", () => {
    const decision = decidePushReadiness({
      ownershipValid: true,
      unsavedEditorCount: 0,
      expectedBranch: "main",
      expectedOriginUrl: "https://gitlab.example.test/group/project",
      snapshot: {
        ...safeSnapshot(),
        headAheadOfRemoteTarget: 1,
        localOnlyRefCount: 1,
        unrelatedLocalOnlyRefCount: 0,
      },
    });

    expect(decision).toEqual({ safe: true, blockers: [] });
  });

  it("blocks push when another local ref contains unpushed commits", () => {
    const decision = decidePushReadiness({
      ownershipValid: true,
      unsavedEditorCount: 0,
      expectedBranch: "main",
      expectedOriginUrl: "https://gitlab.example.test/group/project",
      snapshot: {
        ...safeSnapshot(),
        localOnlyRefCount: 2,
        unrelatedLocalOnlyRefCount: 1,
      },
    });

    expect(decision.blockers.map(({ code }) => code)).toContain(
      "localOnlyRefs",
    );
  });

  it("does not allow dirty or ambiguous state to proceed to push", () => {
    const decision = decidePushReadiness({
      ownershipValid: true,
      unsavedEditorCount: 1,
      expectedBranch: "main",
      expectedOriginUrl: "https://gitlab.example.test/group/project",
      snapshot: { ...safeSnapshot(), statusEntryCount: 1, branch: undefined },
    });

    expect(decision.blockers.map(({ code }) => code)).toEqual([
      "unsavedEditors",
      "dirtyGit",
      "branchMismatch",
    ]);
  });

  it("requires exact remote SHA equality after push", () => {
    const decision = decidePostPushSafety({
      ownershipValid: true,
      unsavedEditorCount: 0,
      expectedBranch: "main",
      expectedOriginUrl: "https://gitlab.example.test/group/project",
      snapshot: {
        ...safeSnapshot(),
        remoteTargetSha: "b".repeat(40),
      },
    });

    expect(decision.blockers.map(({ code }) => code)).toContain(
      "postPushMismatch",
    );
  });
});

describe("workspace safety Git parsers", () => {
  it("parses porcelain v2 NUL output and counts a rename once", () => {
    const output =
      "1 .M N... 100644 100644 100644 a a file.txt\0" +
      "2 R. N... 100644 100644 100644 a b R100 new.txt\0old.txt\0" +
      "? untracked.txt\0";
    expect(parsePorcelainV2Z(output)).toHaveLength(3);
  });

  it("parses ahead/behind counts and rejects ambiguous output", () => {
    expect(parseAheadBehind("2\t5")).toEqual({ ahead: 2, behind: 5 });
    expect(() => parseAheadBehind("unknown")).toThrow("invalid ahead/behind");
  });
});

function safeSnapshot(): GitSafetySnapshot {
  return {
    schemaVersion: 1,
    capturedAt: "2026-09-17T00:00:00.000Z",
    topLevel: "/managed/workspace",
    gitDirectory: "/managed/workspace/.git",
    commonGitDirectory: "/managed/workspace/.git",
    branch: "main",
    headSha: "a".repeat(40),
    originUrl: "https://gitlab.example.test/group/project",
    statusEntryCount: 0,
    operationStates: [],
    upstream: "refs/remotes/origin/main",
    ahead: 0,
    behind: 0,
    remoteTarget: "refs/remotes/origin/main",
    remoteTargetSha: "a".repeat(40),
    headAheadOfRemoteTarget: 0,
    localRefCount: 1,
    localOnlyRefCount: 0,
    unrelatedLocalOnlyRefCount: 0,
    sparseCheckout: false,
  };
}
