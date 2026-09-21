import * as vscode from "vscode";
import type { ManagedWorkspaceRecord } from "../domain/models.js";
import type { Logger } from "../infrastructure/logger.js";
import type { LoadedWorkspaceRegistry } from "./workspaceRegistry.js";
import { WorkspaceReminderScheduler } from "./workspaceReminder.js";
import type {
  WorkspaceReminderCandidate,
  WorkspaceReminderPolicy,
} from "./workspaceReminder.js";
import type { WorkspaceReminderStore } from "./workspaceReminderStore.js";

const REVIEW_AND_RELEASE = "Review and Release";
const CLOSE_KEEP_LOCAL = "Close Window, Keep Local Copy";
const KEEP_OPEN = "Keep Open";
const REMIND_LATER = "Remind Me Later";

export class WorkspaceReminderService implements vscode.Disposable {
  private readonly suppressed = new Set<string>();
  private readonly scheduler: WorkspaceReminderScheduler;
  private readonly observedAt = Date.now();

  public constructor(
    private readonly registry: LoadedWorkspaceRegistry,
    private readonly store: WorkspaceReminderStore,
    private readonly logger: Logger,
  ) {
    this.scheduler = new WorkspaceReminderScheduler(
      () => this.currentCandidate(),
      () => this.policy(),
      async (record) => {
        try {
          await this.show(record);
        } catch (error) {
          this.logger.error(
            "Workspace reminder failed without taking action",
            error,
          );
        }
      },
    );
  }

  public start(): void {
    this.scheduler.start();
  }

  public restart(): void {
    this.scheduler.restart();
  }

  public dispose(): void {
    this.scheduler.stop();
  }

  private currentCandidate(): WorkspaceReminderCandidate | undefined {
    const folders = vscode.workspace.workspaceFolders;
    if (folders?.length !== 1) return undefined;
    const record = this.registry.getByLocalPath(folders[0]?.uri.fsPath ?? "");
    if (record === undefined) return undefined;
    const snoozedUntil = this.store.get(record.workspaceId);
    return {
      record,
      observedAt: this.observedAt,
      suppressed: this.suppressed.has(record.workspaceId),
      ...(snoozedUntil === undefined ? {} : { snoozedUntil }),
    };
  }

  private policy(): WorkspaceReminderPolicy {
    const configuration = vscode.workspace.getConfiguration(
      "reposhelf.reminders",
    );
    const ageDays = boundedDays(
      configuration.get<number>("ageDays", 7),
      1,
      365,
    );
    return {
      enabled: configuration.get<boolean>("enabled", true),
      reminderAgeMs: ageDays * 24 * 60 * 60 * 1_000,
      checkIntervalMs: 15 * 60 * 1_000,
    };
  }

  private async show(record: ManagedWorkspaceRecord): Promise<void> {
    this.suppressed.add(record.workspaceId);
    const choice = await vscode.window.showInformationMessage(
      `RepoShelf workspace ${record.projectPath} (${record.targetBranch}) has been retained locally since ${formatDate(record.lastOpenedAt)}. No automatic release will occur.`,
      REVIEW_AND_RELEASE,
      CLOSE_KEEP_LOCAL,
      KEEP_OPEN,
      REMIND_LATER,
    );
    switch (choice) {
      case REVIEW_AND_RELEASE:
        await vscode.commands.executeCommand("reposhelf.releaseWorkspace");
        break;
      case CLOSE_KEEP_LOCAL:
        await vscode.commands.executeCommand("workbench.action.closeWindow");
        break;
      case REMIND_LATER: {
        const configuration = vscode.workspace.getConfiguration(
          "reposhelf.reminders",
        );
        const hours = boundedHours(
          configuration.get<number>("snoozeHours", 24),
        );
        await this.store.snooze(
          record.workspaceId,
          Date.now() + hours * 60 * 60 * 1_000,
        );
        this.suppressed.delete(record.workspaceId);
        break;
      }
      case KEEP_OPEN:
      case undefined:
        break;
      default:
        this.logger.error("Unexpected workspace reminder action was ignored");
    }
  }
}

function boundedDays(value: number, minimum: number, maximum: number): number {
  if (!Number.isFinite(value)) return minimum;
  return Math.min(maximum, Math.max(minimum, value));
}

function boundedHours(value: number): number {
  if (!Number.isFinite(value)) return 24;
  return Math.min(24 * 30, Math.max(1, value));
}

function formatDate(value: string): string {
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp)
    ? new Date(timestamp).toLocaleDateString()
    : "an unknown date";
}
