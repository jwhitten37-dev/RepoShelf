import { randomUUID } from "node:crypto";
import type * as vscode from "vscode";

const STORAGE_KEY = "reposhelf.pendingRelease.v1";
const INTENT_LIFETIME_MS = 2 * 60 * 1_000;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

export interface PendingReleaseIntent {
  readonly schemaVersion: 1;
  readonly operationId: string;
  readonly workspaceId: string;
  readonly expectedHeadSha: string;
  readonly createdAt: number;
  readonly expiresAt: number;
}

export class PendingReleaseStore {
  public constructor(
    private readonly state: vscode.Memento,
    private readonly now: () => number = Date.now,
  ) {}

  public async create(
    workspaceId: string,
    expectedHeadSha: string,
  ): Promise<PendingReleaseIntent> {
    const createdAt = this.now();
    const intent: PendingReleaseIntent = {
      schemaVersion: 1,
      operationId: randomUUID(),
      workspaceId,
      expectedHeadSha,
      createdAt,
      expiresAt: createdAt + INTENT_LIFETIME_MS,
    };
    await this.state.update(STORAGE_KEY, intent);
    return intent;
  }

  public async consume(): Promise<PendingReleaseIntent | undefined> {
    const value = this.state.get<unknown>(STORAGE_KEY);
    await this.state.update(STORAGE_KEY, undefined);
    const intent = parseIntent(value);
    const now = this.now();
    return intent !== undefined &&
      now >= intent.createdAt &&
      now <= intent.expiresAt
      ? intent
      : undefined;
  }

  public clear(): Thenable<void> {
    return this.state.update(STORAGE_KEY, undefined);
  }
}

function parseIntent(value: unknown): PendingReleaseIntent | undefined {
  if (
    !isRecord(value) ||
    value.schemaVersion !== 1 ||
    typeof value.operationId !== "string" ||
    !UUID_PATTERN.test(value.operationId) ||
    typeof value.workspaceId !== "string" ||
    !UUID_PATTERN.test(value.workspaceId) ||
    typeof value.expectedHeadSha !== "string" ||
    !/^[0-9a-f]{40}$/u.test(value.expectedHeadSha) ||
    typeof value.createdAt !== "number" ||
    !Number.isFinite(value.createdAt) ||
    typeof value.expiresAt !== "number" ||
    !Number.isFinite(value.expiresAt) ||
    value.expiresAt - value.createdAt !== INTENT_LIFETIME_MS
  ) {
    return undefined;
  }
  return value as unknown as PendingReleaseIntent;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
