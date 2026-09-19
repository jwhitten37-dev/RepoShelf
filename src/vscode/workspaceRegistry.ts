import type * as vscode from "vscode";
import type { ManagedWorkspaceRecord } from "../domain/models.js";
import type { WorkspaceRegistry } from "../infrastructure/materialization.js";

const STORAGE_KEY = "reposhelf.managedWorkspaces.v1";

export interface LoadedWorkspaceRegistry extends WorkspaceRegistry {
  list(): readonly ManagedWorkspaceRecord[];
  remove(workspaceId: string): Promise<void>;
  reload(): Promise<void>;
}

export class VsCodeWorkspaceRegistry implements LoadedWorkspaceRegistry {
  public constructor(private readonly state: vscode.Memento) {}

  public getByLocalPath(localPath: string): ManagedWorkspaceRecord | undefined {
    return this.read().find((record) => samePath(record.localPath, localPath));
  }

  public async save(record: ManagedWorkspaceRecord): Promise<void> {
    const records = this.read().filter(
      (candidate) =>
        candidate.workspaceId !== record.workspaceId &&
        !samePath(candidate.localPath, record.localPath),
    );
    records.push(record);
    await this.state.update(STORAGE_KEY, records);
  }

  public list(): readonly ManagedWorkspaceRecord[] {
    return this.read();
  }

  public async remove(workspaceId: string): Promise<void> {
    await this.state.update(
      STORAGE_KEY,
      this.read().filter((record) => record.workspaceId !== workspaceId),
    );
  }

  public replace(records: readonly ManagedWorkspaceRecord[]): Promise<void> {
    return Promise.resolve(this.state.update(STORAGE_KEY, records));
  }

  public reload(): Promise<void> {
    return Promise.resolve();
  }

  private read(): ManagedWorkspaceRecord[] {
    const value = this.state.get<unknown>(STORAGE_KEY, []);
    if (!Array.isArray(value)) return [];
    return value.filter(isManagedWorkspaceRecord);
  }
}

function isManagedWorkspaceRecord(
  value: unknown,
): value is ManagedWorkspaceRecord {
  if (!isRecord(value)) return false;
  return (
    value.schemaVersion === 1 &&
    typeof value.workspaceId === "string" &&
    typeof value.instanceId === "string" &&
    typeof value.projectId === "number" &&
    typeof value.projectPath === "string" &&
    typeof value.canonicalRepositoryUrl === "string" &&
    typeof value.targetBranch === "string" &&
    typeof value.pinnedCommitSha === "string" &&
    (value.cloneMode === "partialSparse" || value.cloneMode === "full") &&
    Array.isArray(value.sparseDirectories) &&
    value.sparseDirectories.every((item) => typeof item === "string") &&
    typeof value.localPath === "string" &&
    typeof value.cloneRoot === "string" &&
    (typeof value.revealPath === "string" || value.revealPath === undefined) &&
    typeof value.createdAt === "string" &&
    typeof value.lastOpenedAt === "string" &&
    (typeof value.lastVerifiedAt === "string" ||
      value.lastVerifiedAt === undefined) &&
    (typeof value.lastPushedCommitSha === "string" ||
      value.lastPushedCommitSha === undefined)
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function samePath(left: string, right: string): boolean {
  return process.platform === "win32"
    ? left.localeCompare(right, undefined, { sensitivity: "accent" }) === 0
    : left === right;
}
