import type * as vscode from "vscode";
import { describe, expect, it } from "vitest";
import { PendingReleaseStore } from "../src/vscode/pendingReleaseStore.js";

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
});
