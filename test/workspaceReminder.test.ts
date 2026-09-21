import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type * as vscode from "vscode";
import type { ManagedWorkspaceRecord } from "../src/domain/models.js";
import {
  WorkspaceReminderScheduler,
  workspaceReminderDue,
} from "../src/vscode/workspaceReminder.js";
import { WorkspaceReminderStore } from "../src/vscode/workspaceReminderStore.js";

const DAY = 24 * 60 * 60 * 1_000;
const WORKSPACE_ID = "11111111-1111-4111-8111-111111111111";

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

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(10 * DAY);
});

afterEach(() => {
  vi.useRealTimers();
});

describe("workspace reminders", () => {
  it("becomes due only after workspace age and snooze thresholds", () => {
    const candidate = { record: record(0), observedAt: DAY, suppressed: false };
    const policy = {
      enabled: true,
      reminderAgeMs: 7 * DAY,
      checkIntervalMs: 1_000,
    };

    expect(workspaceReminderDue(candidate, policy, 8 * DAY - 1)).toBe(false);
    expect(workspaceReminderDue(candidate, policy, 8 * DAY)).toBe(true);
    expect(
      workspaceReminderDue(
        { ...candidate, snoozedUntil: 20 * DAY },
        policy,
        19 * DAY,
      ),
    ).toBe(false);
    expect(
      workspaceReminderDue(
        { ...candidate, suppressed: true },
        policy,
        100 * DAY,
      ),
    ).toBe(false);
  });

  it("emits notifications only while time advances far beyond thresholds", async () => {
    const notifications: string[] = [];
    const releaseActions: string[] = [];
    const scheduler = new WorkspaceReminderScheduler(
      () => ({
        record: record(0),
        observedAt: 10 * DAY,
        suppressed: notifications.length > 0,
      }),
      () => ({
        enabled: true,
        reminderAgeMs: 7 * DAY,
        checkIntervalMs: DAY,
      }),
      (candidate) => {
        notifications.push(candidate.workspaceId);
        return Promise.resolve();
      },
    );

    scheduler.start();
    await vi.advanceTimersByTimeAsync(1_000 * DAY);
    scheduler.stop();

    expect(notifications).toEqual([WORKSPACE_ID]);
    expect(releaseActions).toEqual([]);
  });

  it("does not arm or notify while reminders are disabled", async () => {
    const notify = vi.fn<(record: ManagedWorkspaceRecord) => Promise<void>>();
    const scheduler = new WorkspaceReminderScheduler(
      () => ({ record: record(0), observedAt: 10 * DAY, suppressed: false }),
      () => ({
        enabled: false,
        reminderAgeMs: DAY,
        checkIntervalMs: 1_000,
      }),
      notify,
    );

    scheduler.start();
    await vi.advanceTimersByTimeAsync(1_000 * DAY);
    scheduler.stop();

    expect(notify).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("keeps snoozes isolated by workspace and rejects malformed state", async () => {
    const state = new MemoryMemento();
    const store = new WorkspaceReminderStore(state);
    const other = "22222222-2222-4222-8222-222222222222";

    await store.snooze(WORKSPACE_ID, 20 * DAY);
    await store.snooze(other, 30 * DAY);

    expect(store.get(WORKSPACE_ID)).toBe(20 * DAY);
    expect(store.get(other)).toBe(30 * DAY);
    await expect(store.snooze("not-a-workspace", 1)).rejects.toThrow("invalid");

    state.setRaw("reposhelf.workspaceReminderSnoozes.v1", [
      { schemaVersion: 1, workspaceId: "forged", snoozedUntil: 100 * DAY },
    ]);
    expect(store.get(WORKSPACE_ID)).toBeUndefined();
  });
});

function record(lastOpenedAt: number): ManagedWorkspaceRecord {
  return {
    schemaVersion: 1,
    workspaceId: WORKSPACE_ID,
    instanceId: "33333333-3333-4333-8333-333333333333",
    projectId: 42,
    projectPath: "group/project",
    canonicalRepositoryUrl: "https://gitlab.example.test/group/project",
    targetBranch: "main",
    pinnedCommitSha: "a".repeat(40),
    cloneMode: "full",
    sparseDirectories: [],
    localPath: "/managed/project",
    cloneRoot: "/managed",
    revealPath: undefined,
    createdAt: new Date(lastOpenedAt).toISOString(),
    lastOpenedAt: new Date(lastOpenedAt).toISOString(),
  };
}
