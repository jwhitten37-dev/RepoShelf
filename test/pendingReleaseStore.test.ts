import type * as vscode from "vscode";
import { describe, expect, it } from "vitest";
import { PendingReleaseStore } from "../src/vscode/pendingReleaseStore.js";
import path from "node:path";
import type { ReleaseRequest } from "../src/infrastructure/coordinationRecords.js";

const WORKSPACE_ID = "11111111-1111-4111-8111-111111111111";
const HEAD_SHA = "a".repeat(40);

class MemoryMemento implements vscode.Memento {
  private readonly values = new Map<string, unknown>();

  public keys(): readonly string[] {
    return [...this.values.keys()];
  }

  public get<T>(key: string): T | undefined;
  public get<T>(key: string, defaultValue: T): T;
  public get<T>(key: string, defaultValue?: T): T | undefined {
    return this.values.has(key) ? (this.values.get(key) as T) : defaultValue;
  }

  public update(key: string, value: unknown): Thenable<void> {
    if (value === undefined) this.values.delete(key);
    else this.values.set(key, value);
    return Promise.resolve();
  }

  public setRaw(key: string, value: unknown): void {
    this.values.set(key, value);
  }
}

describe("PendingReleaseStore", () => {
  it("persists and consumes a valid intent exactly once", async () => {
    const state = new MemoryMemento();
    const store = new PendingReleaseStore(state, () => 1_000);

    const created = await store.create(WORKSPACE_ID, HEAD_SHA);

    expect(created.workspaceId).toBe(WORKSPACE_ID);
    expect(created.expectedHeadSha).toBe(HEAD_SHA);
    expect(created.expiresAt).toBe(121_000);
    await expect(store.consume()).resolves.toEqual(created);
    await expect(store.consume()).resolves.toBeUndefined();
  });

  it("consumes but rejects an expired intent", async () => {
    const state = new MemoryMemento();
    let now = 1_000;
    const store = new PendingReleaseStore(state, () => now);
    await store.create(WORKSPACE_ID, HEAD_SHA);

    now = 121_001;

    await expect(store.consume()).resolves.toBeUndefined();
    await expect(store.consume()).resolves.toBeUndefined();
  });

  it("consumes but rejects malformed persisted state", async () => {
    const state = new MemoryMemento();
    state.setRaw("reposhelf.pendingRelease.v1", {
      schemaVersion: 1,
      operationId: "not-a-uuid",
      workspaceId: WORKSPACE_ID,
      expectedHeadSha: HEAD_SHA,
      createdAt: 1_000,
      expiresAt: 121_000,
    });
    const store = new PendingReleaseStore(state, () => 2_000);

    await expect(store.consume()).resolves.toBeUndefined();
    expect(state.keys()).not.toContain("reposhelf.pendingRelease.v1");
  });

  it("overwrites an older intent and supports explicit clearing", async () => {
    const state = new MemoryMemento();
    const store = new PendingReleaseStore(state, () => 1_000);
    await store.create(WORKSPACE_ID, HEAD_SHA);
    const replacement = await store.create(WORKSPACE_ID, "b".repeat(40));

    await expect(store.consume()).resolves.toEqual(replacement);
    await store.create(WORKSPACE_ID, HEAD_SHA);
    await store.clear();
    await expect(store.consume()).resolves.toBeUndefined();
  });

  it("round-trips a coordinated intent while retaining legacy compatibility", async () => {
    const state = new MemoryMemento();
    const store = new PendingReleaseStore(state, () => 1_000);
    const request = makeRequest();

    const coordinated = await store.createCoordinated(request);

    expect(coordinated.schemaVersion).toBe(2);
    expect(store.peek()).toEqual(coordinated);
    await expect(store.consume()).resolves.toEqual(coordinated);

    const legacy = await store.create(WORKSPACE_ID, HEAD_SHA);
    expect(store.peek()).toEqual(legacy);
    await expect(store.consume()).resolves.toEqual(legacy);
  });

  it("consumes but rejects a coordinated intent with conflicting binding", async () => {
    const state = new MemoryMemento();
    const store = new PendingReleaseStore(state, () => 1_000);
    const coordinated = await store.createCoordinated(makeRequest());
    state.setRaw("reposhelf.pendingRelease.v1", {
      ...coordinated,
      expectedHeadSha: "b".repeat(40),
    });

    expect(store.peek()).toBeUndefined();
    await expect(store.consume()).resolves.toBeUndefined();
  });
});

function makeRequest(): ReleaseRequest {
  return {
    schemaVersion: 1,
    recordType: "releaseRequest",
    workspaceId: WORKSPACE_ID,
    operationId: "22222222-2222-4222-8222-222222222222",
    requestNonce: "33333333-3333-4333-8333-333333333333",
    operationKind: "release",
    instanceId: "44444444-4444-4444-8444-444444444444",
    projectId: 42,
    canonicalRepositoryUrl: "https://gitlab.example.test/group/project",
    targetBranch: "feature/test",
    canonicalLocalPath: path.resolve("managed", "workspace"),
    canonicalCloneRoot: path.resolve("managed"),
    expectedHeadSha: HEAD_SHA,
    coordinatorSessionId: "55555555-5555-4555-8555-555555555555",
    managedSessionId: "66666666-6666-4666-8666-666666666666",
    confirmationAt: 900,
    createdAt: 1_000,
    expiresAt: 121_000,
  };
}
