import { randomUUID } from "node:crypto";
import type * as vscode from "vscode";
import {
  CoordinationRecordError,
  parseReleaseRequest,
  type ReleaseRequest,
} from "../infrastructure/coordinationRecords.js";

const STORAGE_KEY = "reposhelf.pendingRelease.v1";
const INTENT_LIFETIME_MS = 2 * 60 * 1_000;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

export interface LegacyPendingReleaseIntent {
  readonly schemaVersion: 1;
  readonly operationId: string;
  readonly workspaceId: string;
  readonly expectedHeadSha: string;
  readonly createdAt: number;
  readonly expiresAt: number;
}

export interface CoordinatedPendingReleaseIntent {
  readonly schemaVersion: 2;
  readonly intentId: string;
  readonly operationId: string;
  readonly workspaceId: string;
  readonly expectedHeadSha: string;
  readonly createdAt: number;
  readonly expiresAt: number;
  readonly request: ReleaseRequest;
}

export type PendingReleaseIntent =
  LegacyPendingReleaseIntent | CoordinatedPendingReleaseIntent;

export class PendingReleaseStore {
  public constructor(
    private readonly state: vscode.Memento,
    private readonly now: () => number = Date.now,
  ) {}

  public async create(
    workspaceId: string,
    expectedHeadSha: string,
  ): Promise<LegacyPendingReleaseIntent> {
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

  public async createCoordinated(
    request: ReleaseRequest,
  ): Promise<CoordinatedPendingReleaseIntent> {
    const intent: CoordinatedPendingReleaseIntent = {
      schemaVersion: 2,
      intentId: randomUUID(),
      operationId: request.operationId,
      workspaceId: request.workspaceId,
      expectedHeadSha: request.expectedHeadSha,
      createdAt: request.createdAt,
      expiresAt: request.expiresAt,
      request,
    };
    await this.state.update(STORAGE_KEY, intent);
    return intent;
  }

  public peek(): PendingReleaseIntent | undefined {
    return validAt(
      parseIntent(this.state.get<unknown>(STORAGE_KEY)),
      this.now(),
    );
  }

  public async consume(): Promise<PendingReleaseIntent | undefined> {
    const value = this.state.get<unknown>(STORAGE_KEY);
    await this.state.update(STORAGE_KEY, undefined);
    const intent = parseIntent(value);
    const now = this.now();
    return validAt(intent, now);
  }

  public clear(): Thenable<void> {
    return this.state.update(STORAGE_KEY, undefined);
  }
}

function parseIntent(value: unknown): PendingReleaseIntent | undefined {
  if (isRecord(value) && value.schemaVersion === 2) return parseV2Intent(value);
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

function parseV2Intent(
  value: Record<string, unknown>,
): CoordinatedPendingReleaseIntent | undefined {
  if (
    Object.keys(value).some(
      (key) =>
        ![
          "schemaVersion",
          "intentId",
          "operationId",
          "workspaceId",
          "expectedHeadSha",
          "createdAt",
          "expiresAt",
          "request",
        ].includes(key),
    ) ||
    typeof value.intentId !== "string" ||
    !UUID_PATTERN.test(value.intentId) ||
    typeof value.operationId !== "string" ||
    !UUID_PATTERN.test(value.operationId) ||
    typeof value.workspaceId !== "string" ||
    !UUID_PATTERN.test(value.workspaceId) ||
    typeof value.expectedHeadSha !== "string" ||
    !/^[0-9a-f]{40}$/u.test(value.expectedHeadSha) ||
    typeof value.createdAt !== "number" ||
    !Number.isSafeInteger(value.createdAt) ||
    typeof value.expiresAt !== "number" ||
    !Number.isSafeInteger(value.expiresAt) ||
    value.expiresAt - value.createdAt !== INTENT_LIFETIME_MS
  ) {
    return undefined;
  }
  try {
    const request = parseReleaseRequest(value.request);
    if (
      request.operationId !== value.operationId ||
      request.workspaceId !== value.workspaceId ||
      request.expectedHeadSha !== value.expectedHeadSha ||
      request.createdAt !== value.createdAt ||
      request.expiresAt !== value.expiresAt
    ) {
      return undefined;
    }
    return { ...value, request } as unknown as CoordinatedPendingReleaseIntent;
  } catch (error) {
    if (error instanceof CoordinationRecordError) return undefined;
    throw error;
  }
}

function validAt(
  intent: PendingReleaseIntent | undefined,
  now: number,
): PendingReleaseIntent | undefined {
  return intent !== undefined &&
    now >= intent.createdAt &&
    now <= intent.expiresAt
    ? intent
    : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
