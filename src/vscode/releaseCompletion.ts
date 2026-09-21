import * as vscode from "vscode";
import type { Logger } from "../infrastructure/logger.js";
import {
  projectReleaseCompletion,
  type ReleaseCompletionAction,
  type ReleaseCompletionResult,
} from "./releaseCompletionProjection.js";

export interface ReleasedCatalogTarget {
  readonly instanceId: string;
  readonly projectId: number;
  readonly targetBranch: string;
}

export interface ReleaseCatalogRefresher {
  refreshReleasedBranch(target: ReleasedCatalogTarget): Promise<void>;
}

export class ReleaseCompletionPresenter {
  public constructor(
    private readonly catalog: ReleaseCatalogRefresher,
    private readonly logger: Logger,
  ) {}

  public async present(
    target: ReleasedCatalogTarget,
    outcome: ReleaseCompletionResult,
    fallbackHost: boolean,
  ): Promise<void> {
    const presentation = projectReleaseCompletion(
      outcome,
      fallbackHost,
      canCloseWindow(),
    );
    if (presentation === undefined) return;
    const choice =
      presentation.severity === "warning"
        ? await vscode.window.showWarningMessage(
            presentation.message,
            ...presentation.actions,
          )
        : await vscode.window.showInformationMessage(
            presentation.message,
            ...presentation.actions,
          );
    await this.handle(choice, target);
  }

  private async handle(
    action: ReleaseCompletionAction | undefined,
    target: ReleasedCatalogTarget,
  ): Promise<void> {
    switch (action) {
      case "Retry Catalog Refresh":
        try {
          await vscode.window.withProgress(
            {
              location: vscode.ProgressLocation.Notification,
              title: "Retrying RepoShelf catalog refresh…",
            },
            () => this.catalog.refreshReleasedBranch(target),
          );
          await vscode.window.showInformationMessage(
            "Remote catalog refresh succeeded.",
          );
        } catch (error) {
          this.logger.error(
            "Remote catalog refresh retry failed after successful local release",
            error,
          );
          const choice = await vscode.window.showWarningMessage(
            "The local workspace remains released, but the remote catalog refresh failed again.",
            "Show Output",
          );
          if (choice === "Show Output") this.logger.show();
        }
        break;
      case "Browse Remote":
        await vscode.commands.executeCommand("reposhelf.catalog.focus");
        break;
      case "Close Window":
        if (canCloseWindow()) {
          await vscode.commands.executeCommand("workbench.action.closeWindow");
        } else {
          await vscode.window.showWarningMessage(
            "RepoShelf did not close this window because it contains a folder or unsaved or untitled documents.",
          );
        }
        break;
      case "Show Output":
        this.logger.show();
        break;
      case undefined:
        break;
    }
  }
}

function canCloseWindow(): boolean {
  return (
    (vscode.workspace.workspaceFolders?.length ?? 0) === 0 &&
    !vscode.workspace.textDocuments.some(
      (document) => document.isDirty || document.isUntitled,
    )
  );
}
