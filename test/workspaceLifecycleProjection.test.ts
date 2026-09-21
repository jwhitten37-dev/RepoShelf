import { describe, expect, it } from "vitest";
import type { ManagedWorkspaceRecord } from "../src/domain/models.js";
import type { ProjectedOperation } from "../src/infrastructure/coordinationProjection.js";
import { projectWorkspaceLifecycles } from "../src/vscode/workspaceLifecycleProjection.js";

describe("projectWorkspaceLifecycles", () => {
  it("projects registry records without coordination evidence as available", () => {
    expect(projectWorkspaceLifecycles([record(1)], [])).toMatchObject([
      { record: { workspaceId: uuid(1) }, state: "available" },
    ]);
  });

  it.each([
    ["requested", "releaseRequested"],
    ["detached", "detached"],
    ["claimed", "releasing"],
    ["blocked", "blocked"],
    ["failedRetained", "failedRetained"],
    ["interrupted", "interrupted"],
    ["poisoned", "attentionRequired"],
    ["completed", "attentionRequired"],
  ] as const)("maps %s operations to %s", (operationState, state) => {
    expect(
      projectWorkspaceLifecycles(
        [record(1)],
        [operation(1, 10, operationState)],
      ),
    ).toMatchObject([{ state, operationId: uuid(10) }]);
  });

  it("keeps workspaces isolated and gives unsafe active evidence priority", () => {
    const projected = projectWorkspaceLifecycles(
      [record(1), record(2)],
      [
        operation(1, 10, "completed"),
        operation(2, 11, "blocked"),
        operation(2, 12, "poisoned", "DUPLICATE_ACTIVE_OPERATION"),
      ],
    );

    expect(projected).toMatchObject([
      { record: { workspaceId: uuid(1) }, state: "attentionRequired" },
      {
        record: { workspaceId: uuid(2) },
        state: "attentionRequired",
        operationId: uuid(12),
        diagnosticCode: "DUPLICATE_ACTIVE_OPERATION",
      },
    ]);
  });
});

function record(id: number): ManagedWorkspaceRecord {
  return {
    schemaVersion: 1,
    workspaceId: uuid(id),
    instanceId: uuid(100),
    projectId: id,
    projectPath: `group/project-${id}`,
    canonicalRepositoryUrl: `https://gitlab.example.test/group/project-${id}`,
    targetBranch: "main",
    pinnedCommitSha: "a".repeat(40),
    cloneMode: "full",
    sparseDirectories: [],
    localPath: `/managed/project-${id}`,
    cloneRoot: "/managed",
    revealPath: undefined,
    createdAt: "2026-01-01T00:00:00.000Z",
    lastOpenedAt: "2026-01-01T00:00:00.000Z",
  };
}

function operation(
  workspace: number,
  id: number,
  state: ProjectedOperation["state"],
  diagnosticCode?: ProjectedOperation["diagnosticCode"],
): ProjectedOperation {
  return {
    workspaceId: uuid(workspace),
    operationId: uuid(id),
    state,
    ...(diagnosticCode === undefined ? {} : { diagnosticCode }),
  };
}

function uuid(value: number): string {
  return `00000000-0000-4000-8000-${value.toString().padStart(12, "0")}`;
}
