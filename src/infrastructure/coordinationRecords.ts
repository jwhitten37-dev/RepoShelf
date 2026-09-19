import path from "node:path";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const SHA1_PATTERN = /^[0-9a-f]{40}$/u;
const SHA256_PATTERN = /^[0-9a-f]{64}$/u;
const MAX_STRING_LENGTH = 4_096;
const MAX_EXTENSION_VERSION_LENGTH = 128;
const MAX_RECORD_DEPTH = 4;
const MAX_RECORD_KEYS = 48;
const MAX_LEASE_LIFETIME_MS = 2 * 60 * 1_000;

export type CoordinationSessionRole = "coordinator" | "managed" | "detached";
export type ReleaseOperationKind = "release" | "pushAndRelease";
export type ReleaseOutcomeKind =
  "completed" | "blocked" | "failedRetained" | "interrupted";
export type ReconciliationState = "notAttempted" | "succeeded" | "failed";

export interface SessionDescriptor {
  readonly schemaVersion: 1;
  readonly recordType: "sessionDescriptor";
  readonly sessionId: string;
  readonly role: CoordinationSessionRole;
  readonly createdAt: number;
  readonly environmentFingerprint: string;
  readonly extensionVersion: string;
  readonly bootNonce: string;
}

export interface SessionLease {
  readonly schemaVersion: 1;
  readonly recordType: "sessionLease";
  readonly sessionId: string;
  readonly bootNonce: string;
  readonly role: CoordinationSessionRole;
  readonly sequence: number;
  readonly observedAt: number;
  readonly expiresAt: number;
}

export interface MaterializationHandoff {
  readonly schemaVersion: 1;
  readonly recordType: "materializationHandoff";
  readonly workspaceId: string;
  readonly canonicalLocalPath: string;
  readonly coordinatorSessionId: string;
  readonly managedSessionId: string;
  readonly environmentFingerprint: string;
  readonly extensionVersion: string;
  readonly createdAt: number;
  readonly expiresAt: number;
}

export interface ReleaseRequest {
  readonly schemaVersion: 1;
  readonly recordType: "releaseRequest";
  readonly workspaceId: string;
  readonly operationId: string;
  readonly requestNonce: string;
  readonly operationKind: ReleaseOperationKind;
  readonly instanceId: string;
  readonly projectId: number;
  readonly canonicalRepositoryUrl: string;
  readonly targetBranch: string;
  readonly canonicalLocalPath: string;
  readonly canonicalCloneRoot: string;
  readonly expectedHeadSha: string;
  readonly coordinatorSessionId: string;
  readonly managedSessionId: string;
  readonly confirmationAt: number;
  readonly createdAt: number;
  readonly expiresAt: number;
}

export interface DetachmentAcknowledgement {
  readonly schemaVersion: 1;
  readonly recordType: "detachmentAcknowledgement";
  readonly workspaceId: string;
  readonly operationId: string;
  readonly requestNonce: string;
  readonly operationKind: ReleaseOperationKind;
  readonly instanceId: string;
  readonly projectId: number;
  readonly canonicalRepositoryUrl: string;
  readonly targetBranch: string;
  readonly canonicalLocalPath: string;
  readonly canonicalCloneRoot: string;
  readonly expectedHeadSha: string;
  readonly coordinatorSessionId: string;
  readonly managedSessionId: string;
  readonly detachedSessionId: string;
  readonly detachedAt: number;
  readonly consumedIntentId: string;
}

export interface ReleaseClaim {
  readonly schemaVersion: 1;
  readonly recordType: "releaseClaim";
  readonly workspaceId: string;
  readonly operationId: string;
  readonly requestNonce: string;
  readonly operationKind: ReleaseOperationKind;
  readonly instanceId: string;
  readonly projectId: number;
  readonly canonicalRepositoryUrl: string;
  readonly targetBranch: string;
  readonly canonicalLocalPath: string;
  readonly canonicalCloneRoot: string;
  readonly expectedHeadSha: string;
  readonly coordinatorSessionId: string;
  readonly managedSessionId: string;
  readonly claimantSessionId: string;
  readonly claimantBootNonce: string;
  readonly claimantRole: "coordinator" | "detached";
  readonly claimedAt: number;
}

export interface ReleaseOutcome {
  readonly schemaVersion: 1;
  readonly recordType: "releaseOutcome";
  readonly workspaceId: string;
  readonly operationId: string;
  readonly requestNonce: string;
  readonly claimantSessionId: string;
  readonly outcome: ReleaseOutcomeKind;
  readonly deletionVerified: boolean;
  readonly registryReconciliation: ReconciliationState;
  readonly catalogRefresh: ReconciliationState;
  readonly createdAt: number;
  readonly diagnosticCode?: string;
}

export class CoordinationRecordError extends Error {
  public constructor(
    message = "Coordination record is invalid or unsupported.",
  ) {
    super(message);
    this.name = "CoordinationRecordError";
  }
}

export function parseSessionDescriptor(value: unknown): SessionDescriptor {
  assertBoundedValue(value);
  assertExactKeys(value, [
    "schemaVersion",
    "recordType",
    "sessionId",
    "role",
    "createdAt",
    "environmentFingerprint",
    "extensionVersion",
    "bootNonce",
  ]);
  assertHeader(value, "sessionDescriptor");
  assertUuid(value.sessionId);
  assertSessionRole(value.role);
  assertTimestamp(value.createdAt);
  assertString(value.environmentFingerprint, SHA256_PATTERN);
  assertString(value.extensionVersion, undefined, MAX_EXTENSION_VERSION_LENGTH);
  assertUuid(value.bootNonce);
  return value as unknown as SessionDescriptor;
}

export function parseSessionLease(value: unknown): SessionLease {
  assertBoundedValue(value);
  assertExactKeys(value, [
    "schemaVersion",
    "recordType",
    "sessionId",
    "bootNonce",
    "role",
    "sequence",
    "observedAt",
    "expiresAt",
  ]);
  assertHeader(value, "sessionLease");
  assertUuid(value.sessionId);
  assertUuid(value.bootNonce);
  assertSessionRole(value.role);
  assertNonnegativeInteger(value.sequence);
  assertTimestamp(value.observedAt);
  assertTimestamp(value.expiresAt);
  if (
    value.expiresAt <= value.observedAt ||
    value.expiresAt - value.observedAt > MAX_LEASE_LIFETIME_MS
  ) {
    invalid();
  }
  return value as unknown as SessionLease;
}

export function parseMaterializationHandoff(
  value: unknown,
): MaterializationHandoff {
  assertBoundedValue(value);
  assertExactKeys(value, [
    "schemaVersion",
    "recordType",
    "workspaceId",
    "canonicalLocalPath",
    "coordinatorSessionId",
    "managedSessionId",
    "environmentFingerprint",
    "extensionVersion",
    "createdAt",
    "expiresAt",
  ]);
  if (
    value.schemaVersion !== 1 ||
    value.recordType !== "materializationHandoff"
  ) {
    invalid();
  }
  assertUuid(value.workspaceId);
  assertAbsolutePath(value.canonicalLocalPath);
  assertUuid(value.coordinatorSessionId);
  assertUuid(value.managedSessionId);
  assertString(value.environmentFingerprint, SHA256_PATTERN, 64);
  assertString(value.extensionVersion, undefined, MAX_EXTENSION_VERSION_LENGTH);
  assertTimestamp(value.createdAt);
  assertTimestamp(value.expiresAt);
  if (
    value.expiresAt <= value.createdAt ||
    value.expiresAt - value.createdAt > MAX_LEASE_LIFETIME_MS
  ) {
    invalid();
  }
  return value as unknown as MaterializationHandoff;
}

export function parseReleaseRequest(value: unknown): ReleaseRequest {
  assertBoundedValue(value);
  assertExactKeys(value, [
    "schemaVersion",
    "recordType",
    ...operationBindingKeys,
    "confirmationAt",
    "createdAt",
    "expiresAt",
  ]);
  assertHeader(value, "releaseRequest");
  assertOperationBinding(value);
  assertTimestamp(value.confirmationAt);
  assertTimestamp(value.createdAt);
  assertTimestamp(value.expiresAt);
  if (
    value.confirmationAt > value.createdAt ||
    value.expiresAt <= value.createdAt
  ) {
    invalid();
  }
  return value as unknown as ReleaseRequest;
}

export function parseDetachmentAcknowledgement(
  value: unknown,
): DetachmentAcknowledgement {
  assertBoundedValue(value);
  assertExactKeys(value, [
    "schemaVersion",
    "recordType",
    ...operationBindingKeys,
    "detachedSessionId",
    "detachedAt",
    "consumedIntentId",
  ]);
  assertHeader(value, "detachmentAcknowledgement");
  assertOperationBinding(value);
  assertUuid(value.detachedSessionId);
  assertTimestamp(value.detachedAt);
  assertUuid(value.consumedIntentId);
  return value as unknown as DetachmentAcknowledgement;
}

export function parseReleaseClaim(value: unknown): ReleaseClaim {
  assertBoundedValue(value);
  assertExactKeys(value, [
    "schemaVersion",
    "recordType",
    ...operationBindingKeys,
    "claimantSessionId",
    "claimantBootNonce",
    "claimantRole",
    "claimedAt",
  ]);
  assertHeader(value, "releaseClaim");
  assertOperationBinding(value);
  assertUuid(value.claimantSessionId);
  assertUuid(value.claimantBootNonce);
  if (
    value.claimantRole !== "coordinator" &&
    value.claimantRole !== "detached"
  ) {
    invalid();
  }
  assertTimestamp(value.claimedAt);
  return value as unknown as ReleaseClaim;
}

export function parseReleaseOutcome(value: unknown): ReleaseOutcome {
  assertBoundedValue(value);
  assertExactKeys(
    value,
    [
      "schemaVersion",
      "recordType",
      "workspaceId",
      "operationId",
      "requestNonce",
      "claimantSessionId",
      "outcome",
      "deletionVerified",
      "registryReconciliation",
      "catalogRefresh",
      "createdAt",
    ],
    ["diagnosticCode"],
  );
  assertHeader(value, "releaseOutcome");
  assertUuid(value.workspaceId);
  assertUuid(value.operationId);
  assertUuid(value.requestNonce);
  assertUuid(value.claimantSessionId);
  if (
    value.outcome !== "completed" &&
    value.outcome !== "blocked" &&
    value.outcome !== "failedRetained" &&
    value.outcome !== "interrupted"
  ) {
    invalid();
  }
  if (typeof value.deletionVerified !== "boolean") invalid();
  assertReconciliationState(value.registryReconciliation);
  assertReconciliationState(value.catalogRefresh);
  assertTimestamp(value.createdAt);
  if (value.diagnosticCode !== undefined) {
    assertString(value.diagnosticCode, /^[A-Z0-9_]+$/u, 64);
  }
  if (
    (value.outcome === "completed") !== value.deletionVerified ||
    (!value.deletionVerified &&
      (value.registryReconciliation !== "notAttempted" ||
        value.catalogRefresh !== "notAttempted"))
  ) {
    invalid();
  }
  return value as unknown as ReleaseOutcome;
}

export function assertUuid(value: unknown): asserts value is string {
  assertString(value, UUID_PATTERN, 36);
}

const operationBindingKeys = [
  "workspaceId",
  "operationId",
  "requestNonce",
  "operationKind",
  "instanceId",
  "projectId",
  "canonicalRepositoryUrl",
  "targetBranch",
  "canonicalLocalPath",
  "canonicalCloneRoot",
  "expectedHeadSha",
  "coordinatorSessionId",
  "managedSessionId",
] as const;

function assertOperationBinding(value: Record<string, unknown>): void {
  assertUuid(value.workspaceId);
  assertUuid(value.operationId);
  assertUuid(value.requestNonce);
  if (
    value.operationKind !== "release" &&
    value.operationKind !== "pushAndRelease"
  ) {
    invalid();
  }
  assertUuid(value.instanceId);
  assertNonnegativeInteger(value.projectId);
  if (value.projectId === 0) invalid();
  assertCanonicalRepositoryUrl(value.canonicalRepositoryUrl);
  assertString(value.targetBranch);
  assertAbsolutePath(value.canonicalLocalPath);
  assertAbsolutePath(value.canonicalCloneRoot);
  if (!isStrictDescendant(value.canonicalCloneRoot, value.canonicalLocalPath)) {
    invalid();
  }
  assertString(value.expectedHeadSha, SHA1_PATTERN, 40);
  assertUuid(value.coordinatorSessionId);
  assertUuid(value.managedSessionId);
}

function assertHeader(
  value: Record<string, unknown>,
  recordType: string,
): void {
  if (value.schemaVersion !== 1 || value.recordType !== recordType) invalid();
}

function assertExactKeys(
  value: unknown,
  required: readonly string[],
  optional: readonly string[] = [],
): asserts value is Record<string, unknown> {
  if (!isRecord(value)) invalid();
  const actual = Object.keys(value);
  const allowed = new Set([...required, ...optional]);
  if (
    required.some((key) => !Object.hasOwn(value, key)) ||
    actual.some((key) => !allowed.has(key))
  ) {
    invalid();
  }
}

function assertBoundedValue(value: unknown): void {
  let keys = 0;
  const visit = (candidate: unknown, depth: number): void => {
    if (depth > MAX_RECORD_DEPTH) invalid();
    if (typeof candidate === "string") {
      if (candidate.length === 0 || candidate.length > MAX_STRING_LENGTH)
        invalid();
      return;
    }
    if (Array.isArray(candidate)) {
      if (candidate.length > MAX_RECORD_KEYS) invalid();
      candidate.forEach((item) => {
        visit(item, depth + 1);
      });
      return;
    }
    if (isRecord(candidate)) {
      const entries = Object.entries(candidate);
      keys += entries.length;
      if (keys > MAX_RECORD_KEYS) invalid();
      entries.forEach(([, item]) => {
        visit(item, depth + 1);
      });
    }
  };
  visit(value, 0);
}

function assertSessionRole(value: unknown): void {
  if (value !== "coordinator" && value !== "managed" && value !== "detached") {
    invalid();
  }
}

function assertReconciliationState(value: unknown): void {
  if (value !== "notAttempted" && value !== "succeeded" && value !== "failed") {
    invalid();
  }
}

function assertCanonicalRepositoryUrl(value: unknown): asserts value is string {
  assertString(value);
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    invalid();
  }
  if (
    url.protocol !== "https:" ||
    url.username !== "" ||
    url.password !== "" ||
    url.search !== "" ||
    url.hash !== "" ||
    url.pathname === "/" ||
    value !==
      url
        .toString()
        .replace(/\/$/u, "")
        .replace(/\.git$/u, "")
  ) {
    invalid();
  }
}

function assertAbsolutePath(value: unknown): asserts value is string {
  assertString(value);
  if (!path.isAbsolute(value) || path.resolve(value) !== value) invalid();
}

function isStrictDescendant(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return (
    relative !== "" &&
    relative !== ".." &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative)
  );
}

function assertString(
  value: unknown,
  pattern?: RegExp,
  maximumLength = MAX_STRING_LENGTH,
): asserts value is string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > maximumLength ||
    value.includes("\0") ||
    (pattern !== undefined && !pattern.test(value))
  ) {
    invalid();
  }
}

function assertTimestamp(value: unknown): asserts value is number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    invalid();
  }
}

function assertNonnegativeInteger(value: unknown): asserts value is number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    invalid();
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function invalid(): never {
  throw new CoordinationRecordError();
}
