export type WorkspaceSafetyBlockerCode =
  | "ownership"
  | "dirtyGit"
  | "unsavedEditors"
  | "gitOperation"
  | "branchMismatch"
  | "originMismatch"
  | "remoteTargetMissing"
  | "headNotRemote"
  | "postPushMismatch"
  | "localOnlyRefs"
  | "snapshotIncomplete";

export interface GitSafetySnapshot {
  readonly schemaVersion: 1;
  readonly capturedAt: string;
  readonly topLevel: string;
  readonly gitDirectory: string;
  readonly commonGitDirectory: string;
  readonly branch: string | undefined;
  readonly headSha: string;
  readonly originUrl: string;
  readonly statusEntryCount: number;
  readonly operationStates: readonly string[];
  readonly upstream: string | undefined;
  readonly ahead: number | undefined;
  readonly behind: number | undefined;
  readonly remoteTarget: string;
  readonly remoteTargetSha: string | undefined;
  readonly headAheadOfRemoteTarget: number | undefined;
  readonly localRefCount: number;
  readonly localOnlyRefCount: number;
  readonly unrelatedLocalOnlyRefCount: number;
  readonly sparseCheckout: boolean;
}

export interface WorkspaceSafetyEvidence {
  readonly ownershipValid: boolean;
  readonly unsavedEditorCount: number;
  readonly expectedBranch: string;
  readonly expectedOriginUrl: string;
  readonly snapshot: GitSafetySnapshot | undefined;
}

export interface WorkspaceSafetyBlocker {
  readonly code: WorkspaceSafetyBlockerCode;
  readonly message: string;
}

export interface WorkspaceSafetyDecision {
  readonly safe: boolean;
  readonly blockers: readonly WorkspaceSafetyBlocker[];
}

export function decidePushReadiness(
  evidence: WorkspaceSafetyEvidence,
): WorkspaceSafetyDecision {
  const releaseDecision = decideWorkspaceSafety(evidence);
  const pushAllowedCodes = new Set<WorkspaceSafetyBlockerCode>([
    "remoteTargetMissing",
    "headNotRemote",
  ]);
  const blockers = releaseDecision.blockers.filter(
    ({ code }) =>
      !pushAllowedCodes.has(code) &&
      !(
        code === "localOnlyRefs" &&
        evidence.snapshot?.unrelatedLocalOnlyRefCount === 0
      ),
  );
  return { safe: blockers.length === 0, blockers };
}

export function decidePostPushSafety(
  evidence: WorkspaceSafetyEvidence,
): WorkspaceSafetyDecision {
  const decision = decideWorkspaceSafety(evidence);
  const snapshot = evidence.snapshot;
  if (
    snapshot !== undefined &&
    snapshot.remoteTargetSha !== undefined &&
    snapshot.remoteTargetSha !== snapshot.headSha
  ) {
    return {
      safe: false,
      blockers: [
        ...decision.blockers,
        {
          code: "postPushMismatch",
          message:
            "The refreshed remote target does not exactly match local HEAD after push.",
        },
      ],
    };
  }
  return decision;
}

export function decideWorkspaceSafety(
  evidence: WorkspaceSafetyEvidence,
): WorkspaceSafetyDecision {
  const blockers: WorkspaceSafetyBlocker[] = [];
  if (!evidence.ownershipValid) {
    blockers.push({
      code: "ownership",
      message: "Managed-workspace ownership or path containment is not proven.",
    });
  }
  if (evidence.unsavedEditorCount > 0) {
    blockers.push({
      code: "unsavedEditors",
      message: `${evidence.unsavedEditorCount} unsaved editor buffer(s) belong to this workspace.`,
    });
  }
  const snapshot = evidence.snapshot;
  if (snapshot === undefined) {
    blockers.push({
      code: "snapshotIncomplete",
      message: "A complete fresh Git safety snapshot is unavailable.",
    });
    return { safe: false, blockers };
  }
  if (snapshot.statusEntryCount > 0) {
    blockers.push({
      code: "dirtyGit",
      message: `Git reports ${snapshot.statusEntryCount} staged, unstaged, or untracked item(s).`,
    });
  }
  if (snapshot.operationStates.length > 0) {
    blockers.push({
      code: "gitOperation",
      message: `Git operation state is active: ${snapshot.operationStates.join(", ")}.`,
    });
  }
  if (snapshot.branch !== evidence.expectedBranch) {
    blockers.push({
      code: "branchMismatch",
      message: "The current branch does not match the managed target branch.",
    });
  }
  if (snapshot.originUrl !== evidence.expectedOriginUrl) {
    blockers.push({
      code: "originMismatch",
      message: "The origin URL does not match the ownership record.",
    });
  }
  if (snapshot.remoteTargetSha === undefined) {
    blockers.push({
      code: "remoteTargetMissing",
      message:
        "The intended branch is not present in the freshly fetched origin refs.",
    });
  } else if (
    snapshot.headAheadOfRemoteTarget === undefined ||
    snapshot.headAheadOfRemoteTarget > 0
  ) {
    blockers.push({
      code: "headNotRemote",
      message:
        "Local HEAD is not proven reachable from the intended remote branch.",
    });
  }
  if (snapshot.localOnlyRefCount > 0) {
    blockers.push({
      code: "localOnlyRefs",
      message: `${snapshot.localOnlyRefCount} local ref(s) contain commits not reachable from origin.`,
    });
  }
  return { safe: blockers.length === 0, blockers };
}
