import { CoordinationJournalError } from "./coordinationJournal.js";
import type {
  CoordinationJournal,
  OperationLocation,
} from "./coordinationJournal.js";
import type {
  ReleaseClaim,
  ReleaseCancellation,
  ReleaseOutcome,
  ReleaseRequest,
} from "./coordinationRecords.js";

export type ProjectedOperationState =
  | "requested"
  | "detached"
  | "claimed"
  | "completed"
  | "blocked"
  | "failedRetained"
  | "interrupted"
  | "poisoned";

export interface ProjectedOperation extends OperationLocation {
  readonly state: ProjectedOperationState;
  readonly request?: ReleaseRequest;
  readonly claim?: ReleaseClaim;
  readonly outcome?: ReleaseOutcome;
  readonly cancellation?: ReleaseCancellation;
  readonly diagnosticCode?:
    "INVALID_OPERATION" | "UNEXPECTED_ARTIFACT" | "DUPLICATE_ACTIVE_OPERATION";
}

type ProjectionDiagnosticCode = NonNullable<
  ProjectedOperation["diagnosticCode"]
>;

export class CoordinationProjection {
  public constructor(private readonly journal: CoordinationJournal) {}

  public async projectAll(): Promise<readonly ProjectedOperation[]> {
    const locations = await this.journal.discoverOperations();
    const operations: ProjectedOperation[] = [];
    for (const location of locations) {
      operations.push(await this.project(location));
    }
    const activeByWorkspace = new Map<string, ProjectedOperation[]>();
    for (const operation of operations) {
      if (!isActive(operation.state)) continue;
      const active = activeByWorkspace.get(operation.workspaceId) ?? [];
      active.push(operation);
      activeByWorkspace.set(operation.workspaceId, active);
    }
    const duplicated = new Set(
      [...activeByWorkspace.entries()]
        .filter(([, active]) => active.length > 1)
        .flatMap(([, active]) => active.map(operationKey)),
    );
    return operations.map((operation) =>
      duplicated.has(operationKey(operation))
        ? {
            ...operation,
            state: "poisoned",
            diagnosticCode: "DUPLICATE_ACTIVE_OPERATION",
          }
        : operation,
    );
  }

  public async project(
    location: OperationLocation,
  ): Promise<ProjectedOperation> {
    try {
      const artifacts = await this.journal.inspectOperationArtifacts(
        location.workspaceId,
        location.operationId,
      );
      if (artifacts.hasUnexpectedArtifacts) {
        return poisoned(location, "UNEXPECTED_ARTIFACT");
      }
      const request = await this.journal.readRequest(
        location.workspaceId,
        location.operationId,
      );
      if (request === undefined) return poisoned(location, "INVALID_OPERATION");
      const detachment = await this.journal.readDetachment(
        location.workspaceId,
        location.operationId,
      );
      const claim = await this.journal.readClaim(
        location.workspaceId,
        location.operationId,
      );
      const cancellation = await this.journal.readCancellation(
        location.workspaceId,
        location.operationId,
      );
      const outcome = await this.journal.readOutcome(
        location.workspaceId,
        location.operationId,
      );
      if (outcome !== undefined) {
        if (
          claim === undefined ||
          outcome.requestNonce !== claim.requestNonce ||
          outcome.claimantSessionId !== claim.claimantSessionId
        ) {
          return poisoned(location, "INVALID_OPERATION");
        }
        return {
          ...location,
          request,
          claim,
          outcome,
          ...(cancellation === undefined ? {} : { cancellation }),
          state: outcome.outcome,
        };
      }
      if (cancellation !== undefined) {
        if (claim !== undefined) {
          if (detachment === undefined) {
            return poisoned(location, "INVALID_OPERATION");
          }
          return {
            ...location,
            request,
            claim,
            cancellation,
            state: "claimed",
          };
        }
        return {
          ...location,
          request,
          cancellation,
          state: "blocked",
        };
      }
      if (claim !== undefined) {
        if (detachment === undefined) {
          return poisoned(location, "INVALID_OPERATION");
        }
        return { ...location, request, claim, state: "claimed" };
      }
      return {
        ...location,
        request,
        state: detachment === undefined ? "requested" : "detached",
      };
    } catch (error) {
      if (error instanceof CoordinationJournalError) {
        if (error.code === "unsafeStorage") throw error;
        return poisoned(location, "INVALID_OPERATION");
      }
      throw error;
    }
  }
}

function poisoned(
  location: OperationLocation,
  diagnosticCode: ProjectionDiagnosticCode,
): ProjectedOperation {
  return { ...location, state: "poisoned", diagnosticCode };
}

function operationKey(operation: OperationLocation): string {
  return `${operation.workspaceId}:${operation.operationId}`;
}

function isActive(state: ProjectedOperationState): boolean {
  return state === "requested" || state === "detached" || state === "claimed";
}
