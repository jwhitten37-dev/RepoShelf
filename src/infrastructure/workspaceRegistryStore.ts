import { constants } from "node:fs";
import {
  access,
  lstat,
  mkdir,
  open,
  readdir,
  readFile,
  realpath,
  rename,
  rmdir,
  unlink,
  writeFile,
} from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import type { ManagedWorkspaceRecord } from "../domain/models.js";

const REGISTRY_DIRECTORY = "workspace-registry-v1";
const MAX_REGISTRY_RECORDS = 1_024;
const MAX_RECORD_BYTES = 64 * 1_024;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const SHA_PATTERN = /^[0-9a-f]{40}$/u;
const DIRECTORY_MODE = 0o700;
const FILE_MODE = 0o600;

export interface WorkspaceRegistryMirror {
  replace(records: readonly ManagedWorkspaceRecord[]): Promise<void>;
}

export type WorkspaceAbsenceVerifier = (
  expectedCanonicalPath: string,
) => Promise<boolean>;

export class WorkspaceRegistryStoreError extends Error {
  public constructor(
    public readonly code:
      | "unsafeStorage"
      | "invalidRecord"
      | "registryConflict"
      | "mutationBusy"
      | "workspaceMismatch"
      | "workspaceStillExists"
      | "mirrorFailed",
    message: string,
    options?: { cause?: unknown; committed?: boolean },
  ) {
    super(message, { cause: options?.cause });
    this.name = "WorkspaceRegistryStoreError";
    this.committed = options?.committed ?? false;
  }

  public readonly committed: boolean;
}

export class WorkspaceRegistryStore {
  public readonly root: string;

  public constructor(
    globalStoragePath: string,
    private readonly mirror?: WorkspaceRegistryMirror,
  ) {
    if (!path.isAbsolute(globalStoragePath)) {
      throw registryError(
        "unsafeStorage",
        "Registry storage must be absolute.",
      );
    }
    this.root = path.join(path.resolve(globalStoragePath), REGISTRY_DIRECTORY);
  }

  public async initializeFromLegacy(
    legacyRecords: readonly ManagedWorkspaceRecord[],
  ): Promise<void> {
    await createSecureDirectory(this.root);
    const initialized = path.join(this.root, "initialized.json");
    if (await exists(initialized)) {
      await assertInitializedSentinel(initialized);
      return;
    }
    const migrationLock = path.join(this.root, "migration-lock");
    await acquireLock(migrationLock);
    try {
      if (await exists(initialized)) return;
      const records = legacyRecords.map(parseManagedWorkspaceRecord);
      assertNoRegistryConflicts(records);
      for (const record of records) await this.writeSnapshot(record);
      await writeImmutable(initialized, {
        schemaVersion: 1,
        recordType: "registryInitialized",
      });
    } finally {
      await releaseLock(migrationLock);
    }
  }

  public async list(): Promise<readonly ManagedWorkspaceRecord[]> {
    await this.assertInitialized();
    const workspaces = path.join(this.root, "workspaces");
    if (!(await exists(workspaces))) return [];
    await assertSecureDirectory(workspaces);
    const entries = await readBoundedDirectory(
      workspaces,
      MAX_REGISTRY_RECORDS,
    );
    const records: ManagedWorkspaceRecord[] = [];
    for (const entry of entries) {
      if (!entry.isDirectory() || !UUID_PATTERN.test(entry.name)) {
        throw registryError(
          "unsafeStorage",
          "Registry storage contains an unexpected workspace entry.",
        );
      }
      const record = await readSnapshot(
        path.join(workspaces, entry.name, "record.json"),
      );
      const artifacts = await readBoundedDirectory(
        path.join(workspaces, entry.name),
        16,
      );
      if (
        artifacts.some(
          (artifact) =>
            (artifact.name !== "record.json" &&
              !/^\.record\.[0-9a-f-]+\.tmp$/u.test(artifact.name)) ||
            !artifact.isFile(),
        )
      ) {
        throw registryError(
          "unsafeStorage",
          "Registry workspace storage contains an unexpected artifact.",
        );
      }
      if (record.workspaceId !== entry.name) {
        throw registryError(
          "invalidRecord",
          "Registry record does not match its workspace path.",
        );
      }
      records.push(record);
    }
    assertNoRegistryConflicts(records);
    return records.sort((left, right) =>
      left.workspaceId.localeCompare(right.workspaceId),
    );
  }

  public async getByLocalPath(
    localPath: string,
  ): Promise<ManagedWorkspaceRecord | undefined> {
    const matches = (await this.list()).filter((record) =>
      samePath(record.localPath, localPath),
    );
    if (matches.length > 1) {
      throw registryError(
        "registryConflict",
        "Multiple registry records identify the same local path.",
      );
    }
    return matches[0];
  }

  public async save(record: ManagedWorkspaceRecord): Promise<void> {
    const valid = parseManagedWorkspaceRecord(record);
    await this.assertInitialized();
    await this.withWorkspaceLock(valid.workspaceId, async () => {
      await this.withPathLock(valid.localPath, async () => {
        const records = await this.list();
        if (
          records.some(
            (candidate) =>
              candidate.workspaceId !== valid.workspaceId &&
              samePath(candidate.localPath, valid.localPath),
          )
        ) {
          throw registryError(
            "registryConflict",
            "Another workspace registry record already uses this local path.",
          );
        }
        await this.writeSnapshot(valid);
      });
    });
    await this.refreshMirror(true);
  }

  public async removeVerified(
    expected: ManagedWorkspaceRecord,
    verifyAbsent: WorkspaceAbsenceVerifier,
  ): Promise<void> {
    const validExpected = parseManagedWorkspaceRecord(expected);
    await this.assertInitialized();
    await this.withWorkspaceLock(validExpected.workspaceId, async () => {
      await this.withPathLock(validExpected.localPath, async () => {
        const current = await this.readByWorkspaceId(validExpected.workspaceId);
        if (current === undefined || !sameRecord(current, validExpected)) {
          throw registryError(
            "workspaceMismatch",
            "Registry removal requires the exact current workspace record.",
          );
        }
        if (!(await verifyAbsent(current.localPath))) {
          throw registryError(
            "workspaceStillExists",
            "Registry removal requires fresh verified filesystem absence.",
          );
        }
        await unlink(this.snapshotPath(current.workspaceId)).catch(
          (error: unknown) => {
            throw unsafeStorage(error);
          },
        );
        await rmdir(path.dirname(this.snapshotPath(current.workspaceId))).catch(
          (error: unknown) => {
            throw unsafeStorage(error);
          },
        );
      });
    });
    await this.refreshMirror(true);
  }

  public async reconcileMirror(): Promise<void> {
    await this.refreshMirror(false);
  }

  private async assertInitialized(): Promise<void> {
    await createSecureDirectory(this.root);
    const initialized = path.join(this.root, "initialized.json");
    if (!(await exists(initialized))) {
      throw registryError(
        "unsafeStorage",
        "Workspace registry migration has not completed.",
      );
    }
    await assertInitializedSentinel(initialized);
  }

  private async readByWorkspaceId(
    workspaceId: string,
  ): Promise<ManagedWorkspaceRecord | undefined> {
    assertUuid(workspaceId);
    const snapshot = this.snapshotPath(workspaceId);
    return (await exists(snapshot)) ? readSnapshot(snapshot) : undefined;
  }

  private async writeSnapshot(record: ManagedWorkspaceRecord): Promise<void> {
    const directory = path.dirname(this.snapshotPath(record.workspaceId));
    await createSecureDirectory(directory);
    await writeReplaceable(this.snapshotPath(record.workspaceId), record);
  }

  private snapshotPath(workspaceId: string): string {
    assertUuid(workspaceId);
    return path.join(this.root, "workspaces", workspaceId, "record.json");
  }

  private async withWorkspaceLock<T>(
    workspaceId: string,
    operation: () => Promise<T>,
  ): Promise<T> {
    assertUuid(workspaceId);
    const locks = path.join(this.root, "locks");
    await createSecureDirectory(locks);
    const lock = path.join(locks, workspaceId);
    await acquireLock(lock);
    try {
      return await operation();
    } finally {
      await releaseLock(lock);
    }
  }

  private async withPathLock<T>(
    localPath: string,
    operation: () => Promise<T>,
  ): Promise<T> {
    const locks = path.join(this.root, "path-locks");
    await createSecureDirectory(locks);
    const lockName = pathLockName(localPath);
    const lock = path.join(locks, lockName);
    await acquireLock(lock);
    try {
      return await operation();
    } finally {
      await releaseLock(lock);
    }
  }

  private async refreshMirror(committed: boolean): Promise<void> {
    if (this.mirror === undefined) return;
    try {
      await this.mirror.replace(await this.list());
    } catch (error) {
      throw registryError(
        "mirrorFailed",
        "Filesystem registry committed, but its global-state mirror could not be refreshed.",
        error,
        committed,
      );
    }
  }
}

function pathLockName(localPath: string): string {
  const normalized =
    process.platform === "win32" ? localPath.toLocaleLowerCase() : localPath;
  return createHash("sha256").update(normalized).digest("hex");
}

async function acquireLock(lock: string): Promise<void> {
  try {
    await mkdir(lock, { mode: DIRECTORY_MODE });
  } catch (error) {
    if (hasCode(error, "EEXIST")) {
      throw registryError(
        "mutationBusy",
        "A registry mutation lock already exists and will not be stolen.",
      );
    }
    throw unsafeStorage(error);
  }
  await assertSecureDirectory(lock);
}

async function releaseLock(lock: string): Promise<void> {
  try {
    await rmdir(lock);
  } catch (error) {
    throw unsafeStorage(error);
  }
}

async function writeImmutable(file: string, value: unknown): Promise<void> {
  await createSecureDirectory(path.dirname(file));
  await writeFile(file, `${JSON.stringify(value)}\n`, {
    encoding: "utf8",
    flag: "wx",
    mode: FILE_MODE,
  }).catch((error: unknown) => {
    throw unsafeStorage(error);
  });
}

async function writeReplaceable(file: string, value: unknown): Promise<void> {
  const temporary = path.join(
    path.dirname(file),
    `.record.${randomUUID()}.tmp`,
  );
  const handle = await open(temporary, "wx", FILE_MODE).catch(
    (error: unknown) => {
      throw unsafeStorage(error);
    },
  );
  try {
    await handle.writeFile(`${JSON.stringify(value)}\n`, "utf8");
    await handle.sync();
    await handle.close();
    await rename(temporary, file);
  } catch (error) {
    await handle.close().catch(() => undefined);
    throw unsafeStorage(error);
  } finally {
    await unlink(temporary).catch(() => undefined);
  }
}

async function readSnapshot(file: string): Promise<ManagedWorkspaceRecord> {
  await assertSecureFile(file);
  const stat = await lstat(file);
  if (stat.size <= 0 || stat.size > MAX_RECORD_BYTES) {
    throw registryError(
      "invalidRecord",
      "Registry record has an invalid size.",
    );
  }
  try {
    return parseManagedWorkspaceRecord(
      JSON.parse(await readFile(file, "utf8")) as unknown,
    );
  } catch (error) {
    if (error instanceof WorkspaceRegistryStoreError) throw error;
    throw registryError(
      "invalidRecord",
      "Registry record is invalid or unsupported.",
      error,
    );
  }
}

export function parseManagedWorkspaceRecord(
  value: unknown,
): ManagedWorkspaceRecord {
  const required = [
    "schemaVersion",
    "workspaceId",
    "instanceId",
    "projectId",
    "projectPath",
    "canonicalRepositoryUrl",
    "targetBranch",
    "pinnedCommitSha",
    "cloneMode",
    "sparseDirectories",
    "localPath",
    "cloneRoot",
    "createdAt",
    "lastOpenedAt",
  ];
  const optional = ["revealPath", "lastVerifiedAt", "lastPushedCommitSha"];
  if (!isRecord(value)) invalidRecord();
  const allowed = new Set([...required, ...optional]);
  if (
    required.some((key) => !Object.hasOwn(value, key)) ||
    Object.keys(value).some((key) => !allowed.has(key)) ||
    value.schemaVersion !== 1
  ) {
    invalidRecord();
  }
  assertUuid(value.workspaceId);
  assertUuid(value.instanceId);
  if (!Number.isSafeInteger(value.projectId) || Number(value.projectId) <= 0) {
    invalidRecord();
  }
  assertString(value.projectPath);
  assertCanonicalRepositoryUrl(value.canonicalRepositoryUrl);
  assertString(value.targetBranch);
  assertSha(value.pinnedCommitSha);
  if (value.cloneMode !== "partialSparse" && value.cloneMode !== "full") {
    invalidRecord();
  }
  if (
    !Array.isArray(value.sparseDirectories) ||
    value.sparseDirectories.length > 256 ||
    !value.sparseDirectories.every(
      (item) => typeof item === "string" && item.length <= 4_096,
    )
  ) {
    invalidRecord();
  }
  assertAbsolutePath(value.localPath);
  assertAbsolutePath(value.cloneRoot);
  if (!isStrictDescendant(value.cloneRoot, value.localPath)) invalidRecord();
  if (value.revealPath !== undefined) assertString(value.revealPath);
  assertIsoTimestamp(value.createdAt);
  assertIsoTimestamp(value.lastOpenedAt);
  if (value.lastVerifiedAt !== undefined)
    assertIsoTimestamp(value.lastVerifiedAt);
  if (value.lastPushedCommitSha !== undefined)
    assertSha(value.lastPushedCommitSha);
  return value as unknown as ManagedWorkspaceRecord;
}

function assertNoRegistryConflicts(
  records: readonly ManagedWorkspaceRecord[],
): void {
  const workspaceIds = new Set<string>();
  const localPaths: string[] = [];
  for (const record of records) {
    if (
      workspaceIds.has(record.workspaceId) ||
      localPaths.some((candidate) => samePath(candidate, record.localPath))
    ) {
      throw registryError(
        "registryConflict",
        "Workspace registry contains duplicate identities or local paths.",
      );
    }
    workspaceIds.add(record.workspaceId);
    localPaths.push(record.localPath);
  }
}

function sameRecord(
  left: ManagedWorkspaceRecord,
  right: ManagedWorkspaceRecord,
): boolean {
  return (
    left.workspaceId === right.workspaceId &&
    left.instanceId === right.instanceId &&
    left.projectId === right.projectId &&
    left.projectPath === right.projectPath &&
    left.canonicalRepositoryUrl === right.canonicalRepositoryUrl &&
    left.targetBranch === right.targetBranch &&
    left.pinnedCommitSha === right.pinnedCommitSha &&
    left.cloneMode === right.cloneMode &&
    left.sparseDirectories.length === right.sparseDirectories.length &&
    left.sparseDirectories.every(
      (directory, index) => directory === right.sparseDirectories[index],
    ) &&
    samePath(left.localPath, right.localPath) &&
    samePath(left.cloneRoot, right.cloneRoot) &&
    left.revealPath === right.revealPath &&
    left.createdAt === right.createdAt &&
    left.lastOpenedAt === right.lastOpenedAt &&
    left.lastVerifiedAt === right.lastVerifiedAt &&
    left.lastPushedCommitSha === right.lastPushedCommitSha
  );
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
      const stat = await lstat(current);
      if (stat.isSymbolicLink() || !stat.isDirectory()) throw unsafeStorage();
      if (!samePath(await realpath(current), current)) throw unsafeStorage();
      return;
    } catch (error) {
      if (error instanceof WorkspaceRegistryStoreError) throw error;
      if (!hasCode(error, "ENOENT")) throw unsafeStorage(error);
      if (current === filesystemRoot) throw error;
      current = path.dirname(current);
    }
  }
}

async function assertSecureDirectory(directory: string): Promise<void> {
  try {
    const stat = await lstat(directory);
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw unsafeStorage();
    if (!samePath(await realpath(directory), path.resolve(directory))) {
      throw unsafeStorage();
    }
  } catch (error) {
    if (error instanceof WorkspaceRegistryStoreError) throw error;
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
    if (error instanceof WorkspaceRegistryStoreError) throw error;
    throw unsafeStorage(error);
  }
}

async function readBoundedDirectory(directory: string, maximum: number) {
  const entries = await readdir(directory, { withFileTypes: true }).catch(
    (error: unknown) => {
      throw unsafeStorage(error);
    },
  );
  if (entries.length > maximum) throw unsafeStorage();
  return entries.sort((left, right) => left.name.localeCompare(right.name));
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

function assertUuid(value: unknown): asserts value is string {
  if (typeof value !== "string" || !UUID_PATTERN.test(value)) invalidRecord();
}

function assertSha(value: unknown): asserts value is string {
  if (typeof value !== "string" || !SHA_PATTERN.test(value)) invalidRecord();
}

function assertString(value: unknown): asserts value is string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > 4_096 ||
    value.includes("\0")
  ) {
    invalidRecord();
  }
}

function assertCanonicalRepositoryUrl(value: unknown): asserts value is string {
  assertString(value);
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    invalidRecord();
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
    invalidRecord();
  }
}

function assertAbsolutePath(value: unknown): asserts value is string {
  assertString(value);
  if (!path.isAbsolute(value) || path.resolve(value) !== value) invalidRecord();
}

function assertIsoTimestamp(value: unknown): asserts value is string {
  assertString(value);
  const timestamp = Date.parse(value);
  if (
    !Number.isFinite(timestamp) ||
    new Date(timestamp).toISOString() !== value
  ) {
    invalidRecord();
  }
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function invalidRecord(): never {
  throw registryError(
    "invalidRecord",
    "Workspace registry record is invalid or unsupported.",
  );
}

function unsafeStorage(cause?: unknown): WorkspaceRegistryStoreError {
  return registryError(
    "unsafeStorage",
    "Workspace registry storage is unavailable or structurally unsafe.",
    cause,
  );
}

function registryError(
  code: WorkspaceRegistryStoreError["code"],
  message: string,
  cause?: unknown,
  committed = false,
): WorkspaceRegistryStoreError {
  return new WorkspaceRegistryStoreError(code, message, { cause, committed });
}

function hasCode(error: unknown, code: string): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === code
  );
}

function samePath(left: string, right: string): boolean {
  return process.platform === "win32"
    ? left.localeCompare(right, undefined, { sensitivity: "accent" }) === 0
    : left === right;
}

async function assertInitializedSentinel(file: string): Promise<void> {
  await assertSecureFile(file);
  try {
    const value = JSON.parse(await readFile(file, "utf8")) as unknown;
    if (
      !isRecord(value) ||
      Object.keys(value).length !== 2 ||
      value.schemaVersion !== 1 ||
      value.recordType !== "registryInitialized"
    ) {
      invalidRecord();
    }
  } catch (error) {
    if (error instanceof WorkspaceRegistryStoreError) throw error;
    throw registryError(
      "invalidRecord",
      "Workspace registry initialization record is invalid.",
      error,
    );
  }
}
