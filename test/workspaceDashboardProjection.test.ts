import { describe, expect, it } from "vitest";
import type { ManagedWorkspaceRecord } from "../src/domain/models.js";
import type { WorkspaceDiskUsage } from "../src/infrastructure/workspaceRelease.js";
import {
  projectWorkspaceDashboard,
  type WorkspaceDashboardPolicy,
  type WorkspaceSort,
} from "../src/vscode/workspaceDashboardProjection.js";
import type { WorkspaceLifecycleItem } from "../src/vscode/workspaceLifecycleProjection.js";

const day = 24 * 60 * 60 * 1000;
const now = Date.parse("2026-09-22T00:00:00.000Z");

describe("projectWorkspaceDashboard", () => {
  it("projects aggregate usage, unavailable measurements, and recommendations", () => {
    const projected = projectWorkspaceDashboard(
      [
        item(1, "group/zeta", "main", "full", 40),
        item(2, "group/alpha", "dev", "partialSparse", 2),
      ],
      new Map([[uuid(1), usage(3_000)]]),
      policy("sizeDescending", "", 2_000),
    );

    expect(projected).toMatchObject({
      measuredBytes: 3_000,
      measuredCount: 1,
      unavailableCount: 1,
      warningBytes: 2_000,
      exceedsWarning: true,
    });
    expect(
      projected.items.map(({ lifecycle }) => lifecycle.record.workspaceId),
    ).toEqual([uuid(1), uuid(2)]);
    expect(projected.items[0]?.recommendation?.reasons).toEqual([
      "inactive",
      "large",
    ]);
    expect(projected.items[1]?.recommendation).toBeUndefined();
  });

  it("supports project, branch, clone-mode, last-opened, and size sorting", () => {
    const items = [
      item(1, "z/project", "alpha", "full", 20),
      item(2, "a/project", "zeta", "partialSparse", 5),
    ];
    const usages = new Map([
      [uuid(1), usage(100)],
      [uuid(2), usage(200)],
    ]);
    const expected: Readonly<Record<WorkspaceSort, readonly string[]>> = {
      sizeDescending: [uuid(2), uuid(1)],
      lastOpenedDescending: [uuid(2), uuid(1)],
      projectAscending: [uuid(2), uuid(1)],
      branchAscending: [uuid(1), uuid(2)],
      cloneMode: [uuid(1), uuid(2)],
    };

    for (const sort of Object.keys(expected) as WorkspaceSort[]) {
      const projected = projectWorkspaceDashboard(
        items,
        usages,
        policy(sort, "", 1_000),
      );
      expect(
        projected.items.map(({ lifecycle }) => lifecycle.record.workspaceId),
      ).toEqual(expected[sort]);
    }
  });

  it("filters all terms across project, branch, mode, lifecycle, and recommendations", () => {
    const items = [
      item(1, "platform/catalog", "feature/search", "partialSparse", 40),
      item(2, "applications/billing", "main", "full", 1),
    ];
    const projected = projectWorkspaceDashboard(
      items,
      new Map([
        [uuid(1), usage(3_000)],
        [uuid(2), usage(100)],
      ]),
      policy(
        "projectAscending",
        "platform feature sparse recommended inactive large available",
        2_000,
      ),
    );

    expect(projected.items).toHaveLength(1);
    expect(projected.items[0]?.lifecycle.record.workspaceId).toBe(uuid(1));
  });

  it("disables aggregate and per-workspace size warnings at zero", () => {
    const projected = projectWorkspaceDashboard(
      [item(1, "group/project", "main", "full", 1)],
      new Map([[uuid(1), usage(Number.MAX_SAFE_INTEGER)]]),
      policy("sizeDescending", "large", 0),
    );

    expect(projected.exceedsWarning).toBe(false);
    expect(projected.items).toEqual([]);
  });
});

function policy(
  sort: WorkspaceSort,
  filterText: string,
  warningBytes: number,
): WorkspaceDashboardPolicy {
  return {
    sort,
    filterText,
    warningBytes,
    inactiveAgeMs: 30 * day,
    now,
  };
}

function item(
  id: number,
  projectPath: string,
  targetBranch: string,
  cloneMode: ManagedWorkspaceRecord["cloneMode"],
  lastOpenedDaysAgo: number,
): WorkspaceLifecycleItem {
  return {
    state: "available",
    record: {
      schemaVersion: 1,
      workspaceId: uuid(id),
      instanceId: uuid(100),
      projectId: id,
      projectPath,
      canonicalRepositoryUrl: `https://gitlab.example.test/${projectPath}`,
      targetBranch,
      pinnedCommitSha: "a".repeat(40),
      cloneMode,
      sparseDirectories: cloneMode === "full" ? [] : ["src"],
      localPath: `/managed/project-${id}`,
      cloneRoot: "/managed",
      revealPath: undefined,
      createdAt: new Date(now - 100 * day).toISOString(),
      lastOpenedAt: new Date(now - lastOpenedDaysAgo * day).toISOString(),
    },
  };
}

function usage(totalBytes: number): WorkspaceDiskUsage {
  return {
    worktreeBytes: Math.floor(totalBytes / 2),
    gitDirectoryBytes: totalBytes - Math.floor(totalBytes / 2),
    totalBytes,
  };
}

function uuid(value: number): string {
  return `00000000-0000-4000-8000-${value.toString().padStart(12, "0")}`;
}
