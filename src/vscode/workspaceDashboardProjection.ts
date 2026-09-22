import type { ManagedWorkspaceRecord } from "../domain/models.js";
import type { WorkspaceDiskUsage } from "../infrastructure/workspaceRelease.js";
import type { WorkspaceLifecycleItem } from "./workspaceLifecycleProjection.js";

export type WorkspaceSort =
  | "sizeDescending"
  | "lastOpenedDescending"
  | "projectAscending"
  | "branchAscending"
  | "cloneMode";

export interface WorkspaceDashboardPolicy {
  readonly sort: WorkspaceSort;
  readonly filterText: string;
  readonly warningBytes: number;
  readonly inactiveAgeMs: number;
  readonly now: number;
}

export interface WorkspaceRecommendation {
  readonly reasons: readonly ("inactive" | "large")[];
}

export interface WorkspaceDashboardItem {
  readonly lifecycle: WorkspaceLifecycleItem;
  readonly usage: WorkspaceDiskUsage | undefined;
  readonly recommendation: WorkspaceRecommendation | undefined;
}

export interface WorkspaceDashboardProjection {
  readonly items: readonly WorkspaceDashboardItem[];
  readonly measuredBytes: number;
  readonly measuredCount: number;
  readonly unavailableCount: number;
  readonly warningBytes: number;
  readonly exceedsWarning: boolean;
}

export function projectWorkspaceDashboard(
  lifecycles: readonly WorkspaceLifecycleItem[],
  usageByWorkspace: ReadonlyMap<string, WorkspaceDiskUsage | undefined>,
  policy: WorkspaceDashboardPolicy,
): WorkspaceDashboardProjection {
  const projected = lifecycles.map((lifecycle) => {
    const usage = usageByWorkspace.get(lifecycle.record.workspaceId);
    return {
      lifecycle,
      usage,
      recommendation: recommendation(lifecycle.record, usage, policy),
    };
  });
  const filtered = projected.filter((item) =>
    matchesFilter(item, policy.filterText),
  );
  const items = [...filtered].sort((left, right) =>
    compare(left, right, policy.sort),
  );
  const measured = projected.flatMap(({ usage }) =>
    usage === undefined ? [] : [usage],
  );
  const measuredBytes = measured.reduce(
    (total, usage) => total + usage.totalBytes,
    0,
  );
  return {
    items,
    measuredBytes,
    measuredCount: measured.length,
    unavailableCount: lifecycles.length - measured.length,
    warningBytes: policy.warningBytes,
    exceedsWarning:
      policy.warningBytes > 0 && measuredBytes >= policy.warningBytes,
  };
}

export function projectWorkspaceRecommendation(
  record: ManagedWorkspaceRecord,
  usage: WorkspaceDiskUsage | undefined,
  policy: Pick<
    WorkspaceDashboardPolicy,
    "warningBytes" | "inactiveAgeMs" | "now"
  >,
): WorkspaceRecommendation | undefined {
  return recommendation(record, usage, policy);
}

function recommendation(
  record: ManagedWorkspaceRecord,
  usage: WorkspaceDiskUsage | undefined,
  policy: Pick<
    WorkspaceDashboardPolicy,
    "warningBytes" | "inactiveAgeMs" | "now"
  >,
): WorkspaceRecommendation | undefined {
  const lastOpenedAt = Date.parse(record.lastOpenedAt);
  const reasons: ("inactive" | "large")[] = [];
  if (
    Number.isFinite(lastOpenedAt) &&
    policy.now - lastOpenedAt >= policy.inactiveAgeMs
  ) {
    reasons.push("inactive");
  }
  if (
    usage !== undefined &&
    policy.warningBytes > 0 &&
    usage.totalBytes >= policy.warningBytes
  ) {
    reasons.push("large");
  }
  return reasons.length === 0 ? undefined : { reasons };
}

function matchesFilter(
  item: WorkspaceDashboardItem,
  filterText: string,
): boolean {
  const terms = filterText
    .trim()
    .toLocaleLowerCase()
    .split(/\s+/u)
    .filter((term) => term !== "");
  if (terms.length === 0) return true;
  const { record } = item.lifecycle;
  const searchable = [
    record.projectPath,
    record.targetBranch,
    record.cloneMode,
    record.cloneMode === "full" ? "full" : "sparse",
    item.lifecycle.state,
    ...(item.recommendation === undefined
      ? []
      : ["recommended", ...item.recommendation.reasons]),
  ]
    .join(" ")
    .toLocaleLowerCase();
  return terms.every((term) => searchable.includes(term));
}

function compare(
  left: WorkspaceDashboardItem,
  right: WorkspaceDashboardItem,
  sort: WorkspaceSort,
): number {
  const leftRecord = left.lifecycle.record;
  const rightRecord = right.lifecycle.record;
  let result: number;
  switch (sort) {
    case "sizeDescending":
      result = (right.usage?.totalBytes ?? -1) - (left.usage?.totalBytes ?? -1);
      break;
    case "lastOpenedDescending":
      result =
        Date.parse(rightRecord.lastOpenedAt) -
        Date.parse(leftRecord.lastOpenedAt);
      break;
    case "projectAscending":
      result = leftRecord.projectPath.localeCompare(rightRecord.projectPath);
      break;
    case "branchAscending":
      result = leftRecord.targetBranch.localeCompare(rightRecord.targetBranch);
      break;
    case "cloneMode":
      result = leftRecord.cloneMode.localeCompare(rightRecord.cloneMode);
      break;
  }
  return result === 0
    ? leftRecord.workspaceId.localeCompare(rightRecord.workspaceId)
    : result;
}
