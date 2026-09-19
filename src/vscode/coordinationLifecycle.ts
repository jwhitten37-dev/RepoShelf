import { randomUUID } from "node:crypto";
import path from "node:path";
import * as vscode from "vscode";
import type { ManagedWorkspaceRecord } from "../domain/models.js";
import { CoordinationClaimArbiter } from "../infrastructure/coordinationArbitration.js";
import { CoordinationJournal } from "../infrastructure/coordinationJournal.js";
import { CoordinationProjection } from "../infrastructure/coordinationProjection.js";
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

export class VsCodeCoordinationLifecycle implements vscode.Disposable {
  private readonly arbiter: CoordinationClaimArbiter;
  private readonly projection: CoordinationProjection;
  private executor: CoordinatedReleaseExecutor | undefined;
  private timer: NodeJS.Timeout | undefined;
  private scanning = false;
  private readonly processing = new Set<string>();

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
    this.session.stop();
  }

  public enableExecution(
    release: CoordinatedReleaseSafetyService,
    registry: CoordinatedReleaseRegistry,
    refreshCatalog: () => void,
  ): void {
    this.executor = new CoordinatedReleaseExecutor(
      this.journal,
      this.projection,
      release,
      registry,
      countUnsavedWorkspaceBuffers,
      refreshCatalog,
      Date.now,
      () => performance.now(),
      undefined,
      (claim) => Promise.resolve(Date.now() > claim.claimedAt + 2 * 60 * 1_000),
    );
    void this.scan();
    this.timer = setInterval(() => void this.scan(), 1_000);
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
      for (const operation of await this.projection.projectAll()) {
        if (operation.state === "claimed") {
          await this.executor.recover(operation);
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
      if (result.outcome.deletionVerified) {
        await vscode.window.showInformationMessage(
          "Local managed workspace released. The remote branch remains available in RepoShelf.",
        );
      }
    } finally {
      this.processing.delete(request.operationId);
    }
  }
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
