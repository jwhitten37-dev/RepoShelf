import type * as vscode from "vscode";
import type { Logger } from "../infrastructure/logger.js";

const NOTIFIED_KEY = "reposhelf.ignoredWorkspaceSettingsNotified.v1";

/**
 * Tells the user when an opened workspace tries to set a RepoShelf setting
 * that is read only from user or remote-machine settings. Logs once per
 * session and warns once per workspace for each setting.
 */
export class IgnoredWorkspaceSettingNotice {
  private readonly reportedThisSession = new Set<string>();

  public constructor(
    private readonly workspaceState: vscode.Memento,
    private readonly logger: Logger,
    private readonly showWarning: (message: string) => Thenable<unknown>,
  ) {}

  public report(settingName: string): void {
    if (this.reportedThisSession.has(settingName)) return;
    this.reportedThisSession.add(settingName);
    this.logger.info(
      `Ignored workspace-level ${settingName}; RepoShelf reads it only from user or remote-machine settings.`,
    );

    const stored = this.workspaceState.get<unknown>(NOTIFIED_KEY, []);
    const notified = Array.isArray(stored)
      ? stored.filter((item): item is string => typeof item === "string")
      : [];
    if (notified.includes(settingName)) return;
    void this.workspaceState.update(NOTIFIED_KEY, [...notified, settingName]);
    void this.showWarning(
      `This workspace sets ${settingName}, which RepoShelf ignores in workspace settings. Configure it in your user settings instead.`,
    );
  }
}
