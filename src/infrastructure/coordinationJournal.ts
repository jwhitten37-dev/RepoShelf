import { constants } from "node:fs";
import {
  access,
  link,
  lstat,
  mkdir,
  open,
  readdir,
  rename,
  unlink,
} from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";
import type { Dirent } from "node:fs";
import {
  CoordinationRecordError,
  assertUuid,
  parseDetachmentAcknowledgement,
  parseMaterializationHandoff,
  parseReleaseClaim,
  parseReleaseCancellation,
  parseReleaseOutcome,
  parseReleaseRequest,
  parseSessionDescriptor,
  parseSessionLease,
  type DetachmentAcknowledgement,
  type MaterializationHandoff,
  type ReleaseClaim,
  type ReleaseCancellation,
  type ReleaseOutcome,
  type ReleaseRequest,
  type SessionDescriptor,
  type SessionLease,
} from "./coordinationRecords.js";

const JOURNAL_DIRECTORY = "coordination-v1";
const MAX_RECORD_BYTES = 32 * 1_024;
const FILE_MODE = 0o600;
const DIRECTORY_MODE = 0o700;
const MAX_DISCOVERED_WORKSPACES = 256;
const MAX_OPERATIONS_PER_WORKSPACE = 256;
const MAX_OPERATION_ARTIFACTS = 16;
const MAX_HANDOFFS_PER_WORKSPACE = 32;

export type ClaimResult = "claimed" | "alreadyClaimed";

export interface OperationLocation {
  readonly workspaceId: string;
  readonly operationId: string;
}

export interface OperationArtifacts extends OperationLocation {
  readonly names: readonly string[];
  readonly hasUnexpectedArtifacts: boolean;
}

export class CoordinationJournalError extends Error {
  public constructor(
    public readonly code:
      "unsafeStorage" | "recordExists" | "invalidRecord" | "poisonedClaim",
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = "CoordinationJournalError";
  }
}

export class CoordinationJournal {
  public readonly root: string;

  public constructor(globalStoragePath: string) {
    if (!path.isAbsolute(globalStoragePath)) {
      throw journalError(
        "unsafeStorage",
        "Coordination storage must be absolute.",
      );
    }
    this.root = path.join(path.resolve(globalStoragePath), JOURNAL_DIRECTORY);
  }

  public async initialize(): Promise<void> {
    await createSecureDirectory(this.root);
  }

  public async discoverOperations(): Promise<readonly OperationLocation[]> {
    await this.initialize();
    const workspacesDirectory = path.join(this.root, "workspaces");
    if (!(await exists(workspacesDirectory))) return [];
    await assertSecureDirectory(workspacesDirectory);
    const workspaceEntries = await readBoundedDirectory(
      workspacesDirectory,
      MAX_DISCOVERED_WORKSPACES,
    );
    const locations: OperationLocation[] = [];
    for (const workspaceEntry of workspaceEntries) {
      if (!workspaceEntry.isDirectory()) throw unsafeStorage();
      assertIdentifier(workspaceEntry.name);
      const operationsDirectory = path.join(
        workspacesDirectory,
        workspaceEntry.name,
        "operations",
      );
      const workspaceArtifacts = await readBoundedDirectory(
        path.join(workspacesDirectory, workspaceEntry.name),
        MAX_OPERATION_ARTIFACTS,
      );
      if (
        workspaceArtifacts.some(
          (artifact) =>
            (artifact.name !== "operations" || !artifact.isDirectory()) &&
            (artifact.name !== "materialization-handoffs" ||
              !artifact.isDirectory()),
        )
      ) {
        throw unsafeStorage();
      }
      if (!(await exists(operationsDirectory))) continue;
      await assertSecureDirectory(operationsDirectory);
      const operationEntries = await readBoundedDirectory(
        operationsDirectory,
        MAX_OPERATIONS_PER_WORKSPACE,
      );
      for (const operationEntry of operationEntries) {
        if (!operationEntry.isDirectory()) throw unsafeStorage();
        assertIdentifier(operationEntry.name);
        locations.push({
          workspaceId: workspaceEntry.name,
          operationId: operationEntry.name,
        });
      }
    }
    return locations;
  }

  public async inspectOperationArtifacts(
    workspaceId: string,
    operationId: string,
  ): Promise<OperationArtifacts> {
    const directory = this.operationDirectory(workspaceId, operationId);
    await assertSecureDirectory(directory);
    const entries = await readBoundedDirectory(
      directory,
      MAX_OPERATION_ARTIFACTS,
    );
    const names = entries.map(({ name }) => name).sort();
    const hasUnexpectedArtifacts = entries.some((entry) => {
      if (/^\.[a-z]+\.json\.[0-9a-f-]+\.tmp$/u.test(entry.name)) {
        return !entry.isFile();
      }
      if (entry.name === "claim") return !entry.isDirectory();
      return (
        !entry.isFile() ||
        (entry.name !== "request.json" &&
          entry.name !== "detached.json" &&
          entry.name !== "cancelled.json" &&
          entry.name !== "outcome.json")
      );
    });
    if (!hasUnexpectedArtifacts && names.includes("claim")) {
      const claimDirectory = path.join(directory, "claim");
      await assertSecureDirectory(claimDirectory);
      const claimEntries = await readBoundedDirectory(
        claimDirectory,
        MAX_OPERATION_ARTIFACTS,
      );
      if (
        claimEntries.some(
          (entry) =>
            (!/^\.claim\.json\.[0-9a-f-]+\.tmp$/u.test(entry.name) &&
              entry.name !== "claim.json") ||
            !entry.isFile(),
        )
      ) {
        return {
          workspaceId,
          operationId,
          names,
          hasUnexpectedArtifacts: true,
        };
      }
    }
    return { workspaceId, operationId, names, hasUnexpectedArtifacts };
  }

  public async publishSessionDescriptor(
    descriptor: SessionDescriptor,
  ): Promise<void> {
    const valid = validate(parseSessionDescriptor, descriptor);
    await this.publishImmutable(
      path.join(this.sessionDirectory(valid.sessionId), "descriptor.json"),
      valid,
    );
  }

  public async readSessionDescriptor(
    sessionId: string,
  ): Promise<SessionDescriptor | undefined> {
    assertIdentifier(sessionId);
    return this.readImmutable(
      path.join(this.sessionDirectory(sessionId), "descriptor.json"),
      parseSessionDescriptor,
    );
  }

  public async writeLease(lease: SessionLease): Promise<void> {
    const valid = validate(parseSessionLease, lease);
    const descriptor = await this.readSessionDescriptor(valid.sessionId);
    if (
      descriptor === undefined ||
      descriptor.bootNonce !== valid.bootNonce ||
      descriptor.role !== valid.role
    ) {
      throw journalError(
        "invalidRecord",
        "Session lease does not match an immutable session descriptor.",
      );
    }
    const previous = await this.readLease(valid.sessionId);
    if (
      previous !== undefined &&
      (previous.bootNonce !== valid.bootNonce ||
        previous.role !== valid.role ||
        valid.sequence <= previous.sequence ||
        valid.observedAt <= previous.observedAt)
    ) {
      throw journalError(
        "invalidRecord",
        "Session lease sequence or observation time regressed.",
      );
    }
    const directory = this.sessionDirectory(valid.sessionId);
    await createSecureDirectory(directory);
    await writeReplaceable(path.join(directory, "lease.json"), valid);
  }

  public async readLease(sessionId: string): Promise<SessionLease | undefined> {
    assertIdentifier(sessionId);
    try {
      return await this.readImmutable(
        path.join(this.sessionDirectory(sessionId), "lease.json"),
        parseSessionLease,
      );
    } catch (error) {
      if (
        error instanceof CoordinationJournalError &&
        error.code === "invalidRecord"
      ) {
        return undefined;
      }
      throw error;
    }
  }

  public async publishMaterializationHandoff(
    handoff: MaterializationHandoff,
  ): Promise<void> {
    const valid = validate(parseMaterializationHandoff, handoff);
    await this.publishImmutable(
      path.join(
        this.root,
        "workspaces",
        valid.workspaceId,
        "materialization-handoffs",
        `${valid.managedSessionId}.json`,
      ),
      valid,
    );
  }

  public async readMaterializationHandoffs(
    workspaceId: string,
  ): Promise<readonly MaterializationHandoff[]> {
    assertIdentifier(workspaceId);
    const directory = path.join(
      this.root,
      "workspaces",
      workspaceId,
      "materialization-handoffs",
    );
    if (!(await exists(directory))) return [];
    await assertSecureDirectory(directory);
    const entries = await readBoundedDirectory(
      directory,
      MAX_HANDOFFS_PER_WORKSPACE,
    );
    const handoffs: MaterializationHandoff[] = [];
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(".json"))
        throw unsafeStorage();
      const managedSessionId = entry.name.slice(0, -".json".length);
      assertIdentifier(managedSessionId);
      const handoff = await this.readImmutable(
        path.join(directory, entry.name),
        parseMaterializationHandoff,
      );
      if (
        handoff === undefined ||
        handoff.workspaceId !== workspaceId ||
        handoff.managedSessionId !== managedSessionId
      ) {
        throw journalError(
          "invalidRecord",
          "Materialization handoff does not match its workspace path.",
        );
      }
      handoffs.push(handoff);
    }
    return handoffs;
  }

  public async publishRequest(request: ReleaseRequest): Promise<void> {
    const valid = validate(parseReleaseRequest, request);
    await this.publishImmutable(
      path.join(
        this.operationDirectory(valid.workspaceId, valid.operationId),
        "request.json",
      ),
      valid,
    );
  }

  public async readRequest(
    workspaceId: string,
    operationId: string,
  ): Promise<ReleaseRequest | undefined> {
    return this.readOperationRecord(
      workspaceId,
      operationId,
      "request.json",
      parseReleaseRequest,
    );
  }

  public async publishDetachment(
    acknowledgement: DetachmentAcknowledgement,
  ): Promise<void> {
    const valid = validate(parseDetachmentAcknowledgement, acknowledgement);
    const request = await this.requireRequest(
      valid.workspaceId,
      valid.operationId,
    );
    assertOperationBindingMatches(request, valid);
    if (
      valid.detachedAt < request.createdAt ||
      valid.detachedAt > request.expiresAt
    ) {
      throw journalError(
        "invalidRecord",
        "Detachment time is outside the release request lifetime.",
      );
    }
    await this.publishImmutable(
      path.join(
        this.operationDirectory(valid.workspaceId, valid.operationId),
        "detached.json",
      ),
      valid,
    );
  }

  public async readDetachment(
    workspaceId: string,
    operationId: string,
  ): Promise<DetachmentAcknowledgement | undefined> {
    return this.readOperationRecord(
      workspaceId,
      operationId,
      "detached.json",
      parseDetachmentAcknowledgement,
    );
  }

  public async claim(claim: ReleaseClaim): Promise<ClaimResult> {
    const valid = validate(parseReleaseClaim, claim);
    const request = await this.requireRequest(
      valid.workspaceId,
      valid.operationId,
    );
    const detachment = await this.readDetachment(
      valid.workspaceId,
      valid.operationId,
    );
    if (detachment === undefined) {
      throw journalError(
        "invalidRecord",
        "A release operation cannot be claimed before detachment.",
      );
    }
    assertOperationBindingMatches(request, valid);
    assertOperationBindingMatches(request, detachment);
    if (
      (await this.readCancellation(valid.workspaceId, valid.operationId)) !==
      undefined
    ) {
      throw journalError(
        "invalidRecord",
        "A cancelled release operation cannot be claimed.",
      );
    }
    if (
      valid.claimedAt < detachment.detachedAt ||
      valid.claimedAt > request.expiresAt
    ) {
      throw journalError(
        "invalidRecord",
        "Atomic claim time is outside the eligible request interval.",
      );
    }
    const operationDirectory = this.operationDirectory(
      valid.workspaceId,
      valid.operationId,
    );
    await createSecureDirectory(operationDirectory);
    const claimDirectory = path.join(operationDirectory, "claim");
    try {
      await mkdir(claimDirectory, { mode: DIRECTORY_MODE });
    } catch (error) {
      if (hasCode(error, "EEXIST")) return "alreadyClaimed";
      throw unsafeStorage(error);
    }
    await assertSecureDirectory(claimDirectory);
    try {
      await this.publishImmutable(
        path.join(claimDirectory, "claim.json"),
        valid,
      );
      return "claimed";
    } catch (error) {
      throw journalError(
        "poisonedClaim",
        "The atomic claim was created but its record could not be published; the operation is blocked.",
        error,
      );
    }
  }

  public async readClaim(
    workspaceId: string,
    operationId: string,
  ): Promise<ReleaseClaim | undefined> {
    assertIdentifier(workspaceId);
    assertIdentifier(operationId);
    const claimDirectory = path.join(
      this.operationDirectory(workspaceId, operationId),
      "claim",
    );
    if (!(await exists(claimDirectory))) return undefined;
    await assertSecureDirectory(claimDirectory);
    const claim = await this.readImmutable(
      path.join(claimDirectory, "claim.json"),
      parseReleaseClaim,
    );
    if (claim === undefined) {
      throw journalError(
        "poisonedClaim",
        "The operation has an incomplete atomic claim and is blocked.",
      );
    }
    assertOperationPathBinding(claim, workspaceId, operationId);
    return claim;
  }

  public async publishCancellation(
    cancellation: ReleaseCancellation,
  ): Promise<void> {
    const valid = validate(parseReleaseCancellation, cancellation);
    const request = await this.requireRequest(
      valid.workspaceId,
      valid.operationId,
    );
    if (
      valid.requestNonce !== request.requestNonce ||
      valid.cancelledAt < request.createdAt
    ) {
      throw journalError(
        "invalidRecord",
        "Release cancellation does not match its request.",
      );
    }
    const session = await this.readSessionDescriptor(valid.cancellingSessionId);
    const claim = await this.readClaim(valid.workspaceId, valid.operationId);
    if (
      (await this.readOutcome(valid.workspaceId, valid.operationId)) !==
      undefined
    ) {
      throw journalError(
        "invalidRecord",
        "A terminal release operation cannot be cancelled.",
      );
    }
    const authorized =
      session !== undefined &&
      session.bootNonce === valid.cancellingBootNonce &&
      ((claim === undefined &&
        session.role === "managed" &&
        session.sessionId === request.managedSessionId) ||
        (claim !== undefined &&
          session.sessionId === claim.claimantSessionId &&
          session.bootNonce === claim.claimantBootNonce));
    if (!authorized) {
      throw journalError(
        "invalidRecord",
        "Release cancellation is not authorized by the managed host or exact claimant.",
      );
    }
    await this.publishImmutable(
      path.join(
        this.operationDirectory(valid.workspaceId, valid.operationId),
        "cancelled.json",
      ),
      valid,
    );
  }

  public async readCancellation(
    workspaceId: string,
    operationId: string,
  ): Promise<ReleaseCancellation | undefined> {
    return this.readOperationRecord(
      workspaceId,
      operationId,
      "cancelled.json",
      parseReleaseCancellation,
    );
  }

  public async publishOutcome(outcome: ReleaseOutcome): Promise<void> {
    const valid = validate(parseReleaseOutcome, outcome);
    const claim = await this.readClaim(valid.workspaceId, valid.operationId);
    if (claim === undefined) {
      throw journalError(
        "invalidRecord",
        "A release outcome requires an atomic claim.",
      );
    }
    if (
      claim.requestNonce !== valid.requestNonce ||
      claim.claimantSessionId !== valid.claimantSessionId ||
      valid.createdAt < claim.claimedAt
    ) {
      throw journalError(
        "invalidRecord",
        "Release outcome does not match its atomic claim.",
      );
    }
    await this.publishImmutable(
      path.join(
        this.operationDirectory(valid.workspaceId, valid.operationId),
        "outcome.json",
      ),
      valid,
    );
  }

  public async readOutcome(
    workspaceId: string,
    operationId: string,
  ): Promise<ReleaseOutcome | undefined> {
    return this.readOperationRecord(
      workspaceId,
      operationId,
      "outcome.json",
      parseReleaseOutcome,
    );
  }

  private sessionDirectory(sessionId: string): string {
    assertIdentifier(sessionId);
    return path.join(this.root, "sessions", sessionId);
  }

  private operationDirectory(workspaceId: string, operationId: string): string {
    assertIdentifier(workspaceId);
    assertIdentifier(operationId);
    return path.join(
      this.root,
      "workspaces",
      workspaceId,
      "operations",
      operationId,
    );
  }

  private async publishImmutable(file: string, value: unknown): Promise<void> {
    await createSecureDirectory(path.dirname(file));
    const temporary = path.join(
      path.dirname(file),
      `.${path.basename(file)}.${randomUUID()}.tmp`,
    );
    try {
      const handle = await open(temporary, "wx", FILE_MODE).catch(
        (error: unknown) => {
          throw unsafeStorage(error);
        },
      );
      try {
        await handle.writeFile(serialize(value), "utf8");
        await handle.sync();
      } finally {
        await handle.close();
      }
      try {
        await link(temporary, file);
      } catch (error) {
        if (hasCode(error, "EEXIST")) {
          throw journalError(
            "recordExists",
            "An immutable coordination record already exists.",
          );
        }
        throw unsafeStorage(error);
      }
    } finally {
      await unlink(temporary).catch(() => undefined);
    }
  }

  private async readOperationRecord<
    T extends { workspaceId: string; operationId: string },
  >(
    workspaceId: string,
    operationId: string,
    filename: string,
    parser: (value: unknown) => T,
  ): Promise<T | undefined> {
    assertIdentifier(workspaceId);
    assertIdentifier(operationId);
    const record = await this.readImmutable(
      path.join(this.operationDirectory(workspaceId, operationId), filename),
      parser,
    );
    if (record !== undefined) {
      assertOperationPathBinding(record, workspaceId, operationId);
    }
    return record;
  }

  private async requireRequest(
    workspaceId: string,
    operationId: string,
  ): Promise<ReleaseRequest> {
    const request = await this.readRequest(workspaceId, operationId);
    if (request === undefined) {
      throw journalError(
        "invalidRecord",
        "A release operation requires an immutable request.",
      );
    }
    return request;
  }

  private async readImmutable<T>(
    file: string,
    parser: (value: unknown) => T,
  ): Promise<T | undefined> {
    if (!(await exists(file))) return undefined;
    await assertSecureFile(file);
    let handle;
    try {
      const noFollow = "O_NOFOLLOW" in constants ? constants.O_NOFOLLOW : 0;
      handle = await open(file, constants.O_RDONLY | noFollow);
      const stat = await handle.stat();
      if (!stat.isFile() || stat.size <= 0 || stat.size > MAX_RECORD_BYTES) {
        throw new CoordinationRecordError();
      }
      const bytes = await handle.readFile();
      if (bytes.byteLength !== stat.size) throw new CoordinationRecordError();
      const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      return validate(parser, JSON.parse(text) as unknown);
    } catch (error) {
      if (error instanceof CoordinationJournalError) throw error;
      throw journalError(
        "invalidRecord",
        "Coordination record is invalid or unsupported.",
        error,
      );
    } finally {
      await handle?.close();
    }
  }
}

async function writeReplaceable(file: string, value: unknown): Promise<void> {
  const temporary = path.join(
    path.dirname(file),
    `.${path.basename(file)}.${randomUUID()}.tmp`,
  );
  try {
    const handle = await open(temporary, "wx", FILE_MODE).catch(
      (error: unknown) => {
        throw unsafeStorage(error);
      },
    );
    try {
      await handle.writeFile(serialize(value), "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    try {
      await rename(temporary, file);
    } catch (error) {
      throw unsafeStorage(error);
    }
  } finally {
    await unlink(temporary).catch(() => undefined);
  }
}

async function createSecureDirectory(directory: string): Promise<void> {
  await assertExistingAncestorsSecure(directory);
  await mkdir(directory, { recursive: true, mode: DIRECTORY_MODE }).catch(
    (error: unknown) => {
      throw unsafeStorage(error);
    },
  );
  await assertSecureDirectory(directory);
}

async function assertExistingAncestorsSecure(candidate: string): Promise<void> {
  let current = path.resolve(candidate);
  const filesystemRoot = path.parse(current).root;
  for (;;) {
    try {
      await assertSecureDirectory(current);
      return;
    } catch (error) {
      if (
        !(error instanceof CoordinationJournalError) ||
        error.code !== "unsafeStorage"
      ) {
        throw error;
      }
      if (await exists(current)) throw error;
    }
    if (current === filesystemRoot) break;
    current = path.dirname(current);
  }
  throw unsafeStorage();
}

async function assertSecureDirectory(directory: string): Promise<void> {
  try {
    const absolute = path.resolve(directory);
    const parsed = path.parse(absolute);
    let current = parsed.root;
    const rootStat = await lstat(current);
    if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
      throw unsafeStorage();
    }
    // Inspect components directly: Windows realpath may expand an ordinary 8.3
    // alias, so textual canonical-path equality is not a reliable link check.
    for (const segment of absolute
      .slice(parsed.root.length)
      .split(path.sep)
      .filter(Boolean)) {
      current = path.join(current, segment);
      const stat = await lstat(current);
      if (stat.isSymbolicLink() || !stat.isDirectory()) throw unsafeStorage();
    }
  } catch (error) {
    if (error instanceof CoordinationJournalError) throw error;
    throw unsafeStorage(error);
  }
}

async function assertSecureFile(file: string): Promise<void> {
  try {
    const stat = await lstat(file);
    if (stat.isSymbolicLink() || !stat.isFile() || stat.nlink !== 1) {
      throw unsafeStorage();
    }
    await assertSecureDirectory(path.dirname(file));
  } catch (error) {
    if (error instanceof CoordinationJournalError) throw error;
    throw unsafeStorage(error);
  }
}

function assertOperationPathBinding(
  record: { workspaceId: string; operationId: string },
  workspaceId: string,
  operationId: string,
): void {
  if (
    record.workspaceId !== workspaceId ||
    record.operationId !== operationId
  ) {
    throw journalError(
      "invalidRecord",
      "Coordination record does not match its workspace operation path.",
    );
  }
}

const OPERATION_BINDING_KEYS = [
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

function assertOperationBindingMatches(
  expected: ReleaseRequest,
  actual: DetachmentAcknowledgement | ReleaseClaim,
): void {
  if (OPERATION_BINDING_KEYS.some((key) => expected[key] !== actual[key])) {
    throw journalError(
      "invalidRecord",
      "Coordination records contain conflicting operation identities.",
    );
  }
}

function assertIdentifier(value: string): void {
  try {
    assertUuid(value);
  } catch (error) {
    throw journalError(
      "invalidRecord",
      "Coordination identifier is invalid.",
      error,
    );
  }
}

function validate<T>(parser: (value: unknown) => T, value: unknown): T {
  try {
    return parser(value);
  } catch (error) {
    if (error instanceof CoordinationJournalError) throw error;
    throw journalError(
      "invalidRecord",
      "Coordination record is invalid or unsupported.",
      error,
    );
  }
}

function serialize(value: unknown): string {
  const serialized = `${JSON.stringify(value)}\n`;
  if (Buffer.byteLength(serialized, "utf8") > MAX_RECORD_BYTES) {
    throw journalError(
      "invalidRecord",
      "Coordination record exceeds its size limit.",
    );
  }
  return serialized;
}

function unsafeStorage(cause?: unknown): CoordinationJournalError {
  return journalError(
    "unsafeStorage",
    "Coordination storage is unavailable or structurally unsafe.",
    cause,
  );
}

function journalError(
  code: CoordinationJournalError["code"],
  message: string,
  cause?: unknown,
): CoordinationJournalError {
  return new CoordinationJournalError(code, message, { cause });
}

function hasCode(error: unknown, code: string): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === code
  );
}

async function exists(candidate: string): Promise<boolean> {
  try {
    await access(candidate, constants.F_OK);
    return true;
  } catch (error) {
    if (hasCode(error, "ENOENT")) return false;
    throw unsafeStorage(error);
  }
}

async function readBoundedDirectory(
  directory: string,
  maximumEntries: number,
): Promise<readonly Dirent[]> {
  let entries: Dirent[];
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    throw unsafeStorage(error);
  }
  if (entries.length > maximumEntries) {
    throw journalError(
      "unsafeStorage",
      "Coordination storage exceeds its bounded discovery limit.",
    );
  }
  return entries.sort((left, right) => left.name.localeCompare(right.name));
}
