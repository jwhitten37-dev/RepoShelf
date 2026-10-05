import { randomUUID } from "node:crypto";
import path from "node:path";
import * as vscode from "vscode";
import type { ManagedWorkspaceRecord } from "../domain/models.js";
import { CoordinationClaimArbiter } from "../infrastructure/coordinationArbitration.js";
import { CoordinationJournal } from "../infrastructure/coordinationJournal.js";
import {
  CoordinationProjection,
  type ProjectedOperation,
} from "../infrastructure/coordinationProjection.js";
import {
  CoordinatedReleaseExecutor,
  type CoordinatedReleaseRegistry,
  type CoordinatedReleaseSafetyService,
} from "../infrastructure/coordinatedRelease.js";
import {
  CoordinationSession,
  createEnvironmentFingerprint,
} from "../infrastructure/coordinationSession.js";
import type {
  MaterializationHandoff,
  ReleaseOutcome,
  ReleaseOperationKind,
  ReleaseRequest,
} from "../infrastructure/coordinationRecords.js";
import type { Logger } from "../infrastructure/logger.js";
import type {
  PendingReleaseIntent,
  PendingReleaseStore,
} from "./pendingReleaseStore.js";
import type { LoadedWorkspaceRegistry } from "./workspaceRegistry.js";
import { countUnsavedWorkspaceBuffers } from "./workspaceBuffers.js";
import type {
  ReleaseCatalogRefresher,
  ReleasedCatalogTarget,
} from "./releaseCompletion.js";
import {
  canCloseWindow,
  ReleaseCompletionPresenter,
} from "./releaseCompletion.js";
import { shouldCloseEmptyHost } from "./releaseCompletionProjection.js";

const ACTIVE_RELEASE_STATES = new Set(["requested", "detached", "claimed"]);

export class VsCodeCoordinationLifecycle implements vscode.Disposable {
  private readonly arbiter: CoordinationClaimArbiter;
  private readonly projection: CoordinationProjection;
  private readonly operationsChanged = new vscode.EventEmitter<void>();
  private executor: CoordinatedReleaseExecutor | undefined;
  private completionPresenter: ReleaseCompletionPresenter | undefined;
  private timer: NodeJS.Timeout | undefined;
  private scanning = false;
  private readonly processing = new Set<string>();
  private acknowledgedOperationId: string | undefined;
  private closingEmptyHost = false;
  private readonly releaseProgress = new Map<string, () => void>();

  public readonly onDidChangeOperations = this.operationsChanged.event;

  private constructor(
    private readonly journal: CoordinationJournal,
    private readonly session: CoordinationSession,
    private readonly registry: LoadedWorkspaceRegistry,
    private readonly pending: PendingReleaseStore,
    private readonly logger: Logger,
    private readonly adoptedHandoff?: MaterializationHandoff,
  ) {
    this.arbiter = new CoordinationClaimArbiter(journal);
    this.projection = new CoordinationProjection(journal);
  }

  public static async start(
    context: vscode.ExtensionContext,
    registry: LoadedWorkspaceRegistry,
    pending: PendingReleaseStore,
    logger: Logger,
  ): Promise<VsCodeCoordinationLifecycle> {
    const journal = new CoordinationJournal(context.globalStorageUri.fsPath);
    const fingerprint = createEnvironmentFingerprint({
      extensionId: context.extension.id,
      applicationName: vscode.env.appName,
      applicationHost: vscode.env.appHost,
      uiKind: vscode.env.uiKind,
      ...(vscode.env.remoteName === undefined
        ? {}
        : { remoteName: vscode.env.remoteName }),
    });
    const version = extensionVersion(context);
    const record = currentManagedRecord(registry);
    let adoptedHandoff: MaterializationHandoff | undefined;
    if (record !== undefined) {
      const candidates: MaterializationHandoff[] = [];
      for (const candidate of await journal.readMaterializationHandoffs(
        record.workspaceId,
      )) {
        if (
          isAdoptable(candidate, record, fingerprint, version, Date.now()) &&
          (await journal.readSessionDescriptor(candidate.managedSessionId)) ===
            undefined
        ) {
          candidates.push(candidate);
        }
      }
      if (candidates.length === 1) adoptedHandoff = candidates[0];
    }
    const role =
      record !== undefined
        ? "managed"
        : pending.peek() !== undefined
          ? "detached"
          : "coordinator";
    const session = new CoordinationSession(
      journal,
      role,
      fingerprint,
      version,
      undefined,
      adoptedHandoff === undefined
        ? undefined
        : {
            sessionId: adoptedHandoff.managedSessionId,
            bootNonce: randomUUID(),
          },
    );
    await session.start();
    logger.info(
      `Coordination session ${session.descriptor.sessionId} started as ${role}`,
    );
    return new VsCodeCoordinationLifecycle(
      journal,
      session,
      registry,
      pending,
      logger,
      adoptedHandoff,
    );
  }

  public dispose(): void {
    if (this.timer !== undefined) clearInterval(this.timer);
    this.timer = undefined;
    for (const done of this.releaseProgress.values()) done();
    this.releaseProgress.clear();
    this.session.stop();
    this.operationsChanged.dispose();
  }

  public enableExecution(
    release: CoordinatedReleaseSafetyService,
    registry: CoordinatedReleaseRegistry,
    catalog: ReleaseCatalogRefresher,
  ): void {
    this.completionPresenter = new ReleaseCompletionPresenter(
      catalog,
      this.logger,
    );
    this.executor = new CoordinatedReleaseExecutor(
      this.journal,
      this.projection,
      release,
      registry,
      countUnsavedWorkspaceBuffers,
      (record) => catalog.refreshReleasedBranch(record),
      Date.now,
      () => performance.now(),
      undefined,
      (claim) => Promise.resolve(Date.now() > claim.claimedAt + 2 * 60 * 1_000),
    );
    void this.scan();
    this.timer = setInterval(() => void this.scan(), 1_000);
  }

  public projectOperations(): Promise<readonly ProjectedOperation[]> {
    return this.projection.projectAll();
  }

  public async beforeOpenManagedWorkspace(
    record: ManagedWorkspaceRecord,
  ): Promise<void> {
    if (this.session.descriptor.role !== "coordinator") return;
    const handoff = this.session.createMaterializationHandoff(
      record.workspaceId,
      path.resolve(record.localPath),
    );
    await this.journal.publishMaterializationHandoff(handoff);
  }

  public async createPendingRelease(
    record: ManagedWorkspaceRecord,
    expectedHeadSha: string,
    operationKind: ReleaseOperationKind,
    confirmationAt: number,
  ): Promise<PendingReleaseIntent> {
    if (
      this.session.descriptor.role !== "managed" ||
      this.adoptedHandoff === undefined
    ) {
      return this.pending.create(record.workspaceId, expectedHeadSha);
    }
    const createdAt = Date.now();
    const request: ReleaseRequest = {
      schemaVersion: 1,
      recordType: "releaseRequest",
      workspaceId: record.workspaceId,
      operationId: randomUUID(),
      requestNonce: randomUUID(),
      operationKind,
      instanceId: record.instanceId,
      projectId: record.projectId,
      canonicalRepositoryUrl: record.canonicalRepositoryUrl,
      targetBranch: record.targetBranch,
      canonicalLocalPath: path.resolve(record.localPath),
      canonicalCloneRoot: path.resolve(record.cloneRoot),
      expectedHeadSha,
      coordinatorSessionId: this.adoptedHandoff.coordinatorSessionId,
      managedSessionId: this.session.descriptor.sessionId,
      confirmationAt,
      createdAt,
      expiresAt: createdAt + 2 * 60 * 1_000,
    };
    const intent = await this.pending.createCoordinated(request);
    await this.journal.publishRequest(request);
    this.operationsChanged.fire();
    return intent;
  }

  public async acknowledgeDetachment(
    intent: PendingReleaseIntent,
  ): Promise<void> {
    if (
      intent.schemaVersion !== 2 ||
      this.session.descriptor.role !== "detached"
    ) {
      return;
    }
    const { request } = intent;
    await this.journal.publishDetachment({
      schemaVersion: 1,
      recordType: "detachmentAcknowledgement",
      ...operationBinding(request),
      detachedSessionId: this.session.descriptor.sessionId,
      detachedAt: Date.now(),
      consumedIntentId: intent.intentId,
    });
    this.acknowledgedOperationId = intent.operationId;
    this.operationsChanged.fire();
  }

  public async resumeCoordinatedRelease(
    intent: PendingReleaseIntent,
  ): Promise<void> {
    if (intent.schemaVersion !== 2) return;
    await this.acknowledgeDetachment(intent);
    await delay(5_100);
    await this.attempt(intent.request);
  }

  public async cancelPendingRelease(
    intent: PendingReleaseIntent,
  ): Promise<void> {
    if (intent.schemaVersion !== 2) return;
    await this.journal.publishCancellation({
      schemaVersion: 1,
      recordType: "releaseCancellation",
      workspaceId: intent.workspaceId,
      operationId: intent.operationId,
      requestNonce: intent.request.requestNonce,
      cancellingSessionId: this.session.descriptor.sessionId,
      cancellingBootNonce: this.session.descriptor.bootNonce,
      cancelledAt: Date.now(),
    });
    this.operationsChanged.fire();
  }

  private async scan(): Promise<void> {
    if (this.scanning || this.executor === undefined) return;
    this.scanning = true;
    try {
      if (
        await this.session.recoverAfterReconciliation(async () => {
          await this.registry.reload();
          await this.projection.projectAll();
        })
      ) {
        this.logger.info(
          `Coordination session ${this.session.descriptor.sessionId} established a fresh lease after reconciliation`,
        );
        return;
      }
      const operations = await this.projection.projectAll();
      this.updateReleaseProgress(operations);
      for (const operation of operations) {
        if (this.closeEmptyHostIfHandedOff(operation)) return;
        if (operation.state === "claimed") {
          const recovered = await this.executor.recover(operation);
          if (recovered !== undefined && operation.request !== undefined) {
            await this.presentResult(operation.request, recovered.outcome);
          }
          this.operationsChanged.fire();
          continue;
        }
        if (
          this.session.descriptor.role === "coordinator" &&
          operation.state === "detached" &&
          operation.request?.coordinatorSessionId ===
            this.session.descriptor.sessionId
        ) {
          await this.attempt(operation.request);
          continue;
        }
        if (
          this.session.descriptor.role === "detached" &&
          operation.state === "detached" &&
          operation.request !== undefined
        ) {
          const detachment = await this.journal.readDetachment(
            operation.workspaceId,
            operation.operationId,
          );
          if (
            detachment?.detachedSessionId === this.session.descriptor.sessionId
          ) {
            await this.attempt(operation.request);
          }
        }
      }
    } catch (error) {
      this.logger.error(
        "Coordination processing failed closed; local data and recovery evidence were retained",
        error,
      );
    } finally {
      this.scanning = false;
    }
  }

  private async attempt(request: ReleaseRequest): Promise<void> {
    if (
      this.executor === undefined ||
      this.session.leaseHealth !== "healthy" ||
      this.processing.has(request.operationId)
    ) {
      return;
    }
    this.processing.add(request.operationId);
    try {
      const decision = await this.arbiter.attemptClaim(
        request,
        this.session.descriptor,
      );
      if (decision !== "claimed") return;
      const result = await this.executor.execute(
        {
          workspaceId: request.workspaceId,
          operationId: request.operationId,
        },
        this.session.descriptor,
      );
      this.logger.info(
        `Coordinated release ${request.operationId} finished as ${result.outcome.outcome}; registry=${result.outcome.registryReconciliation}; catalog=${result.outcome.catalogRefresh}`,
      );
      void this.presentResult(request, result.outcome).catch(
        (error: unknown) => {
          this.logger.error("Release completion notification failed", error);
        },
      );
    } finally {
      this.processing.delete(request.operationId);
      this.operationsChanged.fire();
    }
  }

  private async presentResult(
    request: ReleaseRequest,
    outcome: ReleaseOutcome,
  ): Promise<void> {
    if (!outcome.deletionVerified) {
      await this.completionPresenter?.presentFailure(
        outcome,
        this.projectLabel(request.workspaceId),
      );
      return;
    }
    await this.completionPresenter?.present(
      releaseTarget(request),
      outcome,
      this.session.descriptor.role === "detached",
    );
  }

  // The empty window left by Close Folder has no further role once the
  // coordinator window holds the claim, so it closes instead of lingering.
  private closeEmptyHostIfHandedOff(operation: ProjectedOperation): boolean {
    if (
      this.closingEmptyHost ||
      !shouldCloseEmptyHost({
        role: this.session.descriptor.role,
        acknowledgedOperationId: this.acknowledgedOperationId,
        operation,
        canCloseWindow: canCloseWindow(),
        closeEnabled: vscode.workspace
          .getConfiguration("reposhelf")
          .get<boolean>("release.closeEmptyWindow", true),
      })
    ) {
      return false;
    }
    this.closingEmptyHost = true;
    this.logger.info(
      `Release ${operation.operationId} was claimed by the coordinator window; closing this empty window`,
    );
    void vscode.commands.executeCommand("workbench.action.closeWindow");
    return true;
  }

  // Shows "Releasing <project>…" in the coordinator window while a release it
  // coordinates is in flight.
  private updateReleaseProgress(
    operations: readonly ProjectedOperation[],
  ): void {
    if (this.session.descriptor.role !== "coordinator") return;
    const active = new Set<string>();
    for (const operation of operations) {
      if (
        !ACTIVE_RELEASE_STATES.has(operation.state) ||
        operation.request?.coordinatorSessionId !==
          this.session.descriptor.sessionId
      ) {
        continue;
      }
      active.add(operation.operationId);
      if (this.releaseProgress.has(operation.operationId)) continue;
      let finish: () => void = () => undefined;
      const finished = new Promise<void>((resolve) => {
        finish = resolve;
      });
      this.releaseProgress.set(operation.operationId, finish);
      void vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Window,
          title: `Releasing ${this.projectLabel(operation.workspaceId)}…`,
        },
        () => finished,
      );
    }
    for (const [operationId, finish] of this.releaseProgress) {
      if (active.has(operationId)) continue;
      finish();
      this.releaseProgress.delete(operationId);
    }
  }

  private projectLabel(workspaceId: string): string {
    return (
      this.registry.list().find((record) => record.workspaceId === workspaceId)
        ?.projectPath ?? "managed workspace"
    );
  }
}

function releaseTarget(request: ReleaseRequest): ReleasedCatalogTarget {
  return {
    instanceId: request.instanceId,
    projectId: request.projectId,
    targetBranch: request.targetBranch,
  };
}

function currentManagedRecord(
  registry: LoadedWorkspaceRegistry,
): ManagedWorkspaceRecord | undefined {
  const folders = vscode.workspace.workspaceFolders;
  return folders?.length === 1
    ? registry.getByLocalPath(folders[0]?.uri.fsPath ?? "")
    : undefined;
}

function isAdoptable(
  handoff: MaterializationHandoff | undefined,
  record: ManagedWorkspaceRecord,
  fingerprint: string,
  version: string,
  now: number,
): handoff is MaterializationHandoff {
  return (
    handoff !== undefined &&
    samePath(handoff.canonicalLocalPath, path.resolve(record.localPath)) &&
    handoff.environmentFingerprint === fingerprint &&
    handoff.extensionVersion === version &&
    now >= handoff.createdAt &&
    now <= handoff.expiresAt
  );
}

function extensionVersion(context: vscode.ExtensionContext): string {
  const value = (context.extension.packageJSON as Record<string, unknown>)
    .version;
  if (typeof value !== "string" || value.length === 0 || value.length > 128) {
    throw new Error("Extension version is unavailable for coordination.");
  }
  return value;
}

function operationBinding(request: ReleaseRequest) {
  return {
    workspaceId: request.workspaceId,
    operationId: request.operationId,
    requestNonce: request.requestNonce,
    operationKind: request.operationKind,
    instanceId: request.instanceId,
    projectId: request.projectId,
    canonicalRepositoryUrl: request.canonicalRepositoryUrl,
    targetBranch: request.targetBranch,
    canonicalLocalPath: request.canonicalLocalPath,
    canonicalCloneRoot: request.canonicalCloneRoot,
    expectedHeadSha: request.expectedHeadSha,
    coordinatorSessionId: request.coordinatorSessionId,
    managedSessionId: request.managedSessionId,
  };
}

function samePath(left: string, right: string): boolean {
  return process.platform === "win32"
    ? left.localeCompare(right, undefined, { sensitivity: "accent" }) === 0
    : left === right;
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
