import type { CoordinationJournal } from "./coordinationJournal.js";
import type {
  ReleaseClaim,
  ReleaseRequest,
  SessionDescriptor,
  SessionLease,
} from "./coordinationRecords.js";

const COORDINATOR_PREFERENCE_MS = 5_000;

export type ClaimDecision =
  | "claimed"
  | "observing"
  | "notDetached"
  | "requestExpired"
  | "coordinatorPreferred"
  | "incompatibleSession";

export class CoordinationClaimArbiter {
  public constructor(
    private readonly journal: CoordinationJournal,
    private readonly now: () => number = Date.now,
  ) {}

  public async attemptClaim(
    request: ReleaseRequest,
    claimant: SessionDescriptor,
  ): Promise<ClaimDecision> {
    const detachment = await this.journal.readDetachment(
      request.workspaceId,
      request.operationId,
    );
    if (
      (await this.journal.readCancellation(
        request.workspaceId,
        request.operationId,
      )) !== undefined
    ) {
      return "observing";
    }
    if (detachment === undefined) return "notDetached";
    if (claimant.role === "managed") return "incompatibleSession";
    if (
      (claimant.role === "coordinator" &&
        claimant.sessionId !== request.coordinatorSessionId) ||
      (claimant.role === "detached" &&
        claimant.sessionId !== detachment.detachedSessionId)
    ) {
      return "incompatibleSession";
    }
    const publishedClaimant = await this.journal.readSessionDescriptor(
      claimant.sessionId,
    );
    if (!sameSession(publishedClaimant, claimant)) return "incompatibleSession";
    const now = this.now();
    if (now < request.createdAt || now > request.expiresAt)
      return "requestExpired";
    if (!(await this.hasLiveLease(claimant, now))) return "incompatibleSession";
    const managed = await this.journal.readSessionDescriptor(
      request.managedSessionId,
    );
    const managedLease =
      managed === undefined ? undefined : await this.matchingLease(managed);
    if (
      managed === undefined ||
      managed.role !== "managed" ||
      managed.environmentFingerprint !== claimant.environmentFingerprint ||
      managed.extensionVersion !== claimant.extensionVersion ||
      isLiveLease(managedLease, now)
    ) {
      return "incompatibleSession";
    }
    const coordinator = await this.journal.readSessionDescriptor(
      request.coordinatorSessionId,
    );
    if (
      coordinator === undefined ||
      coordinator.environmentFingerprint !== claimant.environmentFingerprint ||
      coordinator.extensionVersion !== claimant.extensionVersion
    ) {
      return "incompatibleSession";
    }
    if (
      claimant.role === "detached" &&
      now <
        Math.max(detachment.detachedAt, managedLease?.expiresAt ?? 0) +
          COORDINATOR_PREFERENCE_MS &&
      (await this.hasLiveLease(coordinator, now))
    ) {
      return "coordinatorPreferred";
    }
    const claim: ReleaseClaim = {
      schemaVersion: 1,
      recordType: "releaseClaim",
      ...operationBinding(request),
      claimantSessionId: claimant.sessionId,
      claimantBootNonce: claimant.bootNonce,
      claimantRole: claimant.role,
      claimedAt: now,
    };
    return (await this.journal.claim(claim)) === "claimed"
      ? "claimed"
      : "observing";
  }

  private async hasLiveLease(
    descriptor: SessionDescriptor,
    now: number,
  ): Promise<boolean> {
    return isLiveLease(await this.matchingLease(descriptor), now);
  }

  private async matchingLease(
    descriptor: SessionDescriptor,
  ): Promise<SessionLease | undefined> {
    const lease = await this.journal.readLease(descriptor.sessionId);
    return lease?.bootNonce === descriptor.bootNonce ? lease : undefined;
  }
}

function isLiveLease(lease: SessionLease | undefined, now: number): boolean {
  return (
    lease !== undefined && lease.observedAt <= now && lease.expiresAt >= now
  );
}

function sameSession(
  published: SessionDescriptor | undefined,
  claimant: SessionDescriptor,
): boolean {
  return (
    published !== undefined &&
    published.sessionId === claimant.sessionId &&
    published.bootNonce === claimant.bootNonce &&
    published.role === claimant.role &&
    published.environmentFingerprint === claimant.environmentFingerprint &&
    published.extensionVersion === claimant.extensionVersion
  );
}

function operationBinding(request: ReleaseRequest) {
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
