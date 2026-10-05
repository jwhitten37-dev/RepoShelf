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

export interface ReleaseFailurePresentation {
  readonly message: string;
  readonly actions: readonly ["Show Output"];
}

/**
 * The window that claimed a release reports outcomes that did not delete the
 * checkout. The window that requested the release may already be closed, so
 * the claimant is the only place the user can learn about them.
 */
export function projectReleaseFailure(
  outcome: Pick<ReleaseOutcome, "outcome" | "deletionVerified">,
  projectLabel: string,
): ReleaseFailurePresentation | undefined {
  if (outcome.deletionVerified || outcome.outcome === "completed") {
    return undefined;
  }
  const reason =
    outcome.outcome === "blocked"
      ? "was blocked by a safety check"
      : outcome.outcome === "interrupted"
        ? "was interrupted"
        : "could not finish";
  return {
    message: `Release of ${projectLabel} ${reason}. The local checkout was kept; review the RepoShelf output for details.`,
    actions: ["Show Output"],
  };
}

export interface EmptyHostCloseInput {
  readonly role: "coordinator" | "detached" | "managed";
  readonly acknowledgedOperationId: string | undefined;
  readonly operation: {
    readonly operationId: string;
    readonly request?: { readonly coordinatorSessionId: string };
    readonly claim?: {
      readonly claimantRole: "coordinator" | "detached";
      readonly claimantSessionId: string;
    };
  };
  readonly canCloseWindow: boolean;
  readonly closeEnabled: boolean;
}

/**
 * Whether the empty window left behind by a release handoff should close.
 * Only after the requesting coordinator window has claimed the release: that
 * window is then known to be running, so closing never quits VS Code, and
 * claims are never transferred, so this window has no further role.
 */
export function shouldCloseEmptyHost(input: EmptyHostCloseInput): boolean {
  const { operation } = input;
  return (
    input.closeEnabled &&
    input.canCloseWindow &&
    input.role === "detached" &&
    input.acknowledgedOperationId === operation.operationId &&
    operation.request !== undefined &&
    operation.claim?.claimantRole === "coordinator" &&
    operation.claim.claimantSessionId === operation.request.coordinatorSessionId
  );
}
