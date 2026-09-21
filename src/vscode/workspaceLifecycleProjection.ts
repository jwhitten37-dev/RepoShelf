import type { ManagedWorkspaceRecord } from "../domain/models.js";
import type {
  ProjectedOperation,
  ProjectedOperationState,
} from "../infrastructure/coordinationProjection.js";

export type WorkspaceLifecycleState =
  | "available"
  | "releaseRequested"
  | "detached"
  | "releasing"
  | "blocked"
  | "failedRetained"
  | "interrupted"
  | "attentionRequired";

export interface WorkspaceLifecycleItem {
  readonly record: ManagedWorkspaceRecord;
  readonly state: WorkspaceLifecycleState;
  readonly operationId?: string;
  readonly diagnosticCode?: string;
}

export function projectWorkspaceLifecycles(
  records: readonly ManagedWorkspaceRecord[],
  operations: readonly ProjectedOperation[],
): readonly WorkspaceLifecycleItem[] {
  const byWorkspace = new Map<string, ProjectedOperation[]>();
  for (const operation of operations) {
    const existing = byWorkspace.get(operation.workspaceId) ?? [];
    existing.push(operation);
    byWorkspace.set(operation.workspaceId, existing);
  }

  return records.map((record) => {
    const candidates = byWorkspace.get(record.workspaceId) ?? [];
    const operation = selectOperation(candidates);
    if (operation === undefined) return { record, state: "available" };
    const state = lifecycleState(operation.state);
    return {
      record,
      state,
      operationId: operation.operationId,
      ...(operation.diagnosticCode === undefined
        ? {}
        : { diagnosticCode: operation.diagnosticCode }),
    };
  });
}

function selectOperation(
  operations: readonly ProjectedOperation[],
): ProjectedOperation | undefined {
  return [...operations].sort((left, right) => {
    const priority = statePriority(right.state) - statePriority(left.state);
    if (priority !== 0) return priority;
    return right.operationId.localeCompare(left.operationId);
  })[0];
}

function statePriority(state: ProjectedOperationState): number {
  switch (state) {
    case "poisoned":
      return 8;
    case "claimed":
      return 7;
    case "detached":
      return 6;
    case "requested":
      return 5;
    case "failedRetained":
      return 4;
    case "interrupted":
      return 3;
    case "blocked":
      return 2;
    case "completed":
      return 1;
  }
}

function lifecycleState(
  state: ProjectedOperationState,
): WorkspaceLifecycleState {
  switch (state) {
    case "requested":
      return "releaseRequested";
    case "detached":
      return "detached";
    case "claimed":
      return "releasing";
    case "blocked":
      return "blocked";
    case "failedRetained":
      return "failedRetained";
    case "interrupted":
      return "interrupted";
    case "poisoned":
      return "attentionRequired";
    case "completed":
      return "attentionRequired";
  }
}
