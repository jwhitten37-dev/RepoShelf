import { constants } from "node:fs";
import { access } from "node:fs/promises";
import type { ManagedWorkspaceRecord } from "../domain/models.js";
import type { WorkspaceRegistry } from "./materialization.js";
import type { ReleaseRegistry } from "./workspaceRelease.js";
import { WorkspaceRegistryStoreError } from "./workspaceRegistryStore.js";
import type { WorkspaceRegistryStore } from "./workspaceRegistryStore.js";

export class AuthoritativeWorkspaceRegistry
  implements WorkspaceRegistry, ReleaseRegistry
{
  private constructor(
    private readonly store: WorkspaceRegistryStore,
    private records: readonly ManagedWorkspaceRecord[],
  ) {}

  public static async load(
    store: WorkspaceRegistryStore,
    legacyRecords: readonly ManagedWorkspaceRecord[],
  ): Promise<AuthoritativeWorkspaceRegistry> {
    await initializeWithBoundedWait(store, legacyRecords);
    const records = await store.list();
    await store.reconcileMirror();
    return new AuthoritativeWorkspaceRegistry(store, records);
  }

  public getByLocalPath(localPath: string): ManagedWorkspaceRecord | undefined {
    return this.records.find((record) => samePath(record.localPath, localPath));
  }

  public list(): readonly ManagedWorkspaceRecord[] {
    return this.records;
  }

  public async save(record: ManagedWorkspaceRecord): Promise<void> {
    try {
      await this.store.save(record);
    } catch (error) {
      await this.reloadAfterCommittedMutation(error);
      throw error;
    }
    await this.reload();
  }

  public async remove(workspaceId: string): Promise<void> {
    const record = this.records.find(
      (candidate) => candidate.workspaceId === workspaceId,
    );
    if (record === undefined) {
      throw new WorkspaceRegistryStoreError(
        "workspaceMismatch",
        "Registry removal requires an existing exact workspace record.",
      );
    }
    await this.removeVerified(record);
  }

  public async removeVerified(record: ManagedWorkspaceRecord): Promise<void> {
    try {
      await this.store.removeVerified(record, isAbsent);
    } catch (error) {
      await this.reloadAfterCommittedMutation(error);
      throw error;
    }
    await this.reload();
  }

  public async reload(): Promise<void> {
    this.records = await this.store.list();
  }

  private async reloadAfterCommittedMutation(error: unknown): Promise<void> {
    if (error instanceof WorkspaceRegistryStoreError && error.committed) {
      await this.reload();
    }
  }
}

async function initializeWithBoundedWait(
  store: WorkspaceRegistryStore,
  legacyRecords: readonly ManagedWorkspaceRecord[],
): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      await store.initializeFromLegacy(legacyRecords);
      return;
    } catch (error) {
      if (
        !(error instanceof WorkspaceRegistryStoreError) ||
        error.code !== "mutationBusy" ||
        attempt >= 49
      ) {
        throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
}

async function isAbsent(candidate: string): Promise<boolean> {
  try {
    await access(candidate, constants.F_OK);
    return false;
  } catch (error) {
    if (hasCode(error, "ENOENT")) return true;
    throw error;
  }
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
