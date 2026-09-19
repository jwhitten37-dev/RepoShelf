import { createHash, randomUUID } from "node:crypto";
import type { CoordinationJournal } from "./coordinationJournal.js";
import type {
  CoordinationSessionRole,
  MaterializationHandoff,
  SessionDescriptor,
  SessionLease,
} from "./coordinationRecords.js";

const LEASE_LIFETIME_MS = 30_000;
const RENEWAL_INTERVAL_MS = 10_000;
const MAX_CLOCK_DIVERGENCE_MS = 5_000;
const HANDOFF_LIFETIME_MS = 2 * 60 * 1_000;

export interface CoordinationClock {
  wallTime(): number;
  monotonicTime(): number;
  setTimeout(callback: () => void | Promise<void>, delayMs: number): unknown;
  clearTimeout(handle: unknown): void;
}

const systemClock: CoordinationClock = {
  wallTime: Date.now,
  monotonicTime: () => performance.now(),
  setTimeout: (callback, delayMs) =>
    setTimeout(() => {
      void callback();
    }, delayMs),
  clearTimeout: (handle) => {
    clearTimeout(handle as NodeJS.Timeout);
  },
};

export type LeaseHealth = "healthy" | "indeterminate" | "stopped";

export interface EnvironmentFingerprintInput {
  readonly extensionId: string;
  readonly applicationName: string;
  readonly applicationHost: string;
  readonly uiKind: number;
  readonly remoteName?: string;
}

export function createEnvironmentFingerprint(
  input: EnvironmentFingerprintInput,
): string {
  return createHash("sha256")
    .update(
      JSON.stringify([
        input.extensionId,
        input.applicationName,
        input.applicationHost,
        input.uiKind,
        input.remoteName ?? "local",
        process.platform,
        process.arch,
      ]),
    )
    .digest("hex");
}

export class CoordinationSession {
  public readonly descriptor: SessionDescriptor;
  private sequence = 0;
  private health: LeaseHealth = "stopped";
  private timer: unknown;
  private lastWallTime = 0;
  private lastMonotonicTime = 0;

  public constructor(
    private readonly journal: CoordinationJournal,
    role: CoordinationSessionRole,
    environmentFingerprint: string,
    extensionVersion: string,
    private readonly clock: CoordinationClock = systemClock,
    identity: { readonly sessionId: string; readonly bootNonce: string } = {
      sessionId: randomUUID(),
      bootNonce: randomUUID(),
    },
  ) {
    this.descriptor = {
      schemaVersion: 1,
      recordType: "sessionDescriptor",
      sessionId: identity.sessionId,
      role,
      createdAt: clock.wallTime(),
      environmentFingerprint,
      extensionVersion,
      bootNonce: identity.bootNonce,
    };
  }

  public get leaseHealth(): LeaseHealth {
    return this.health;
  }

  public async start(): Promise<void> {
    await this.journal.publishSessionDescriptor(this.descriptor);
    this.health = "healthy";
    await this.renew();
  }

  public stop(): void {
    if (this.timer !== undefined) this.clock.clearTimeout(this.timer);
    this.timer = undefined;
    this.health = "stopped";
  }

  public async establishFreshLease(): Promise<void> {
    if (this.health === "stopped") throw new Error("Session is stopped.");
    await this.renew(true);
    this.health = "healthy";
  }

  public async recoverAfterReconciliation(
    reconcile: () => Promise<void>,
  ): Promise<boolean> {
    if (this.health !== "indeterminate") return false;
    await reconcile();
    await this.establishFreshLease();
    return true;
  }

  public createMaterializationHandoff(
    workspaceId: string,
    canonicalLocalPath: string,
    managedSessionId = randomUUID(),
  ): MaterializationHandoff {
    const createdAt = this.clock.wallTime();
    return {
      schemaVersion: 1,
      recordType: "materializationHandoff",
      workspaceId,
      canonicalLocalPath,
      coordinatorSessionId: this.descriptor.sessionId,
      managedSessionId,
      environmentFingerprint: this.descriptor.environmentFingerprint,
      extensionVersion: this.descriptor.extensionVersion,
      createdAt,
      expiresAt: createdAt + HANDOFF_LIFETIME_MS,
    };
  }

  private async renew(resetObservation = false): Promise<void> {
    if (this.health === "stopped") return;
    const wallTime = this.clock.wallTime();
    const monotonicTime = this.clock.monotonicTime();
    if (!resetObservation && this.sequence > 0) {
      const wallElapsed = wallTime - this.lastWallTime;
      const monotonicElapsed = monotonicTime - this.lastMonotonicTime;
      if (
        monotonicElapsed < 0 ||
        monotonicElapsed > RENEWAL_INTERVAL_MS + MAX_CLOCK_DIVERGENCE_MS ||
        wallElapsed < 0 ||
        Math.abs(wallElapsed - monotonicElapsed) > MAX_CLOCK_DIVERGENCE_MS
      ) {
        this.health = "indeterminate";
        return;
      }
    }
    const nextSequence = this.sequence + 1;
    const lease: SessionLease = {
      schemaVersion: 1,
      recordType: "sessionLease",
      sessionId: this.descriptor.sessionId,
      bootNonce: this.descriptor.bootNonce,
      role: this.descriptor.role,
      sequence: nextSequence,
      observedAt: wallTime,
      expiresAt: wallTime + LEASE_LIFETIME_MS,
    };
    await this.journal.writeLease(lease);
    this.sequence = nextSequence;
    this.lastWallTime = wallTime;
    this.lastMonotonicTime = monotonicTime;
    this.scheduleRenewal();
  }

  private scheduleRenewal(): void {
    if (this.timer !== undefined) this.clock.clearTimeout(this.timer);
    this.timer = this.clock.setTimeout(async () => {
      await this.renew().catch(() => {
        this.health = "indeterminate";
      });
    }, RENEWAL_INTERVAL_MS);
  }
}
