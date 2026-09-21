import type {
  ReconciliationState,
  ReleaseOutcome,
} from "../infrastructure/coordinationRecords.js";

export type ReleaseCompletionResult = Pick<
  ReleaseOutcome,
  "deletionVerified" | "registryReconciliation" | "catalogRefresh"
>;

export type ReleaseCompletionAction =
  "Retry Catalog Refresh" | "Browse Remote" | "Close Window" | "Show Output";

export interface ReleaseCompletionPresentation {
  readonly severity: "information" | "warning";
  readonly message: string;
  readonly actions: readonly ReleaseCompletionAction[];
}

export function projectReleaseCompletion(
  outcome: ReleaseCompletionResult,
  fallbackHost: boolean,
  canCloseWindow: boolean,
): ReleaseCompletionPresentation | undefined {
  if (!outcome.deletionVerified) return undefined;
  const refreshFailed = outcome.catalogRefresh === "failed";
  const reconciliationFailed = outcome.registryReconciliation === "failed";
  const actions: ReleaseCompletionAction[] = [];
  if (refreshFailed) actions.push("Retry Catalog Refresh");
  if (fallbackHost) actions.push("Browse Remote");
  if (fallbackHost && canCloseWindow) actions.push("Close Window");
  if (refreshFailed || reconciliationFailed) actions.push("Show Output");
  return {
    severity: refreshFailed || reconciliationFailed ? "warning" : "information",
    message: refreshFailed
      ? "Local release succeeded; remote catalog refresh failed. The local checkout is already removed and will not be deleted again."
      : reconciliationFailed
        ? "Local release succeeded, but registry reconciliation needs attention. The remote branch remains available."
        : "Local managed workspace released. The remote branch remains available in RepoShelf.",
    actions,
  };
}

export function completedReleaseResult(
  catalogRefresh: Exclude<ReconciliationState, "notAttempted">,
): ReleaseCompletionResult {
  return {
    deletionVerified: true,
    registryReconciliation: "succeeded",
    catalogRefresh,
  };
}
