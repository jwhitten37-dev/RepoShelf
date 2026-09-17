import type * as vscode from "vscode";

const STORAGE_KEY = "reposhelf.selectedBranches.v1";

export class RefStore {
  public constructor(private readonly state: vscode.Memento) {}

  public get(instanceId: string, projectId: number): string | undefined {
    return this.read()[key(instanceId, projectId)];
  }

  public async set(
    instanceId: string,
    projectId: number,
    branch: string,
  ): Promise<void> {
    await this.state.update(STORAGE_KEY, {
      ...this.read(),
      [key(instanceId, projectId)]: branch,
    });
  }

  private read(): Readonly<Record<string, string>> {
    const value = this.state.get<unknown>(STORAGE_KEY, {});
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      return {};
    }
    return Object.fromEntries(
      Object.entries(value).filter(
        (entry): entry is [string, string] => typeof entry[1] === "string",
      ),
    );
  }
}

function key(instanceId: string, projectId: number): string {
  return `${instanceId}:${projectId}`;
}
