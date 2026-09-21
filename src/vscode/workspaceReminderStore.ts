import type * as vscode from "vscode";

const STORAGE_KEY = "reposhelf.workspaceReminderSnoozes.v1";
const MAX_SNOOZES = 256;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

interface WorkspaceReminderSnooze {
  readonly schemaVersion: 1;
  readonly workspaceId: string;
  readonly snoozedUntil: number;
}

export class WorkspaceReminderStore {
  public constructor(private readonly state: vscode.Memento) {}

  public get(workspaceId: string): number | undefined {
    return this.read().find(
      (candidate) => candidate.workspaceId === workspaceId,
    )?.snoozedUntil;
  }

  public async snooze(
    workspaceId: string,
    snoozedUntil: number,
  ): Promise<void> {
    if (!UUID_PATTERN.test(workspaceId) || !validTimestamp(snoozedUntil)) {
      throw new Error("Workspace reminder snooze is invalid.");
    }
    const records = this.read().filter(
      (candidate) => candidate.workspaceId !== workspaceId,
    );
    records.push({
      schemaVersion: 1,
      workspaceId,
      snoozedUntil,
    });
    records.sort((left, right) => right.snoozedUntil - left.snoozedUntil);
    await this.state.update(STORAGE_KEY, records.slice(0, MAX_SNOOZES));
  }

  private read(): readonly WorkspaceReminderSnooze[] {
    const value = this.state.get<unknown>(STORAGE_KEY, []);
    if (!Array.isArray(value) || value.length > MAX_SNOOZES) return [];
    return value.filter(isSnooze);
  }
}

function isSnooze(value: unknown): value is WorkspaceReminderSnooze {
  return (
    isRecord(value) &&
    Object.keys(value).length === 3 &&
    value.schemaVersion === 1 &&
    typeof value.workspaceId === "string" &&
    UUID_PATTERN.test(value.workspaceId) &&
    validTimestamp(value.snoozedUntil)
  );
}

function validTimestamp(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
