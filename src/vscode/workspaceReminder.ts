import type { ManagedWorkspaceRecord } from "../domain/models.js";

export interface WorkspaceReminderPolicy {
  readonly enabled: boolean;
  readonly reminderAgeMs: number;
  readonly checkIntervalMs: number;
}

export interface WorkspaceReminderCandidate {
  readonly record: ManagedWorkspaceRecord;
  readonly observedAt: number;
  readonly snoozedUntil?: number;
  readonly suppressed: boolean;
}

export interface WorkspaceReminderClock {
  now(): number;
  setInterval(callback: () => void, milliseconds: number): NodeJS.Timeout;
  clearInterval(timer: NodeJS.Timeout): void;
}

const systemClock: WorkspaceReminderClock = {
  now: Date.now,
  setInterval,
  clearInterval,
};

export function workspaceReminderDue(
  candidate: WorkspaceReminderCandidate,
  policy: WorkspaceReminderPolicy,
  now: number,
): boolean {
  if (!policy.enabled || candidate.suppressed) return false;
  if (!Number.isSafeInteger(now) || now < 0) return false;
  const lastOpenedAt = Date.parse(candidate.record.lastOpenedAt);
  if (!Number.isFinite(lastOpenedAt) || lastOpenedAt < 0) return false;
  if (!Number.isSafeInteger(candidate.observedAt) || candidate.observedAt < 0) {
    return false;
  }
  const ageDueAt =
    Math.max(lastOpenedAt, candidate.observedAt) + policy.reminderAgeMs;
  const dueAt = Math.max(ageDueAt, candidate.snoozedUntil ?? 0);
  return now >= dueAt;
}

export class WorkspaceReminderScheduler {
  private timer: NodeJS.Timeout | undefined;
  private evaluating = false;

  public constructor(
    private readonly candidate: () => WorkspaceReminderCandidate | undefined,
    private readonly policy: () => WorkspaceReminderPolicy,
    private readonly remind: (record: ManagedWorkspaceRecord) => Promise<void>,
    private readonly clock: WorkspaceReminderClock = systemClock,
  ) {}

  public start(): void {
    this.stop();
    if (!this.policy().enabled) return;
    void this.evaluate();
    const interval = boundedInterval(this.policy().checkIntervalMs);
    this.timer = this.clock.setInterval(() => {
      void this.evaluate();
    }, interval);
  }

  public restart(): void {
    this.start();
  }

  public stop(): void {
    if (this.timer !== undefined) this.clock.clearInterval(this.timer);
    this.timer = undefined;
  }

  public async evaluate(): Promise<void> {
    if (this.evaluating) return;
    const candidate = this.candidate();
    const policy = this.policy();
    if (
      candidate === undefined ||
      !workspaceReminderDue(candidate, policy, this.clock.now())
    ) {
      return;
    }
    this.evaluating = true;
    try {
      await this.remind(candidate.record);
    } catch {
      // The caller owns diagnostics; scheduler failures never trigger another action.
    } finally {
      this.evaluating = false;
    }
  }
}

function boundedInterval(value: number): number {
  if (!Number.isFinite(value)) return 15 * 60 * 1_000;
  return Math.min(24 * 60 * 60 * 1_000, Math.max(1_000, value));
}
