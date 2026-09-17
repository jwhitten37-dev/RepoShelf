import * as vscode from "vscode";
import { GitLabError } from "../domain/errors.js";
import { parseRemoteFileIdentity } from "../domain/remoteUri.js";
import { BoundedByteCache } from "../infrastructure/byteCache.js";
import type { ClientFactory } from "./clientFactory.js";
import type { InstanceService } from "./instanceService.js";

const FILE_MTIME = 0;

export class RemoteFileSystemProvider implements vscode.FileSystemProvider {
  private readonly changed = new vscode.EventEmitter<
    vscode.FileChangeEvent[]
  >();
  private readonly cache: BoundedByteCache;

  public readonly onDidChangeFile = this.changed.event;

  public constructor(
    private readonly instances: InstanceService,
    private readonly clients: ClientFactory,
    maxEntryBytes: number,
    maxTotalBytes: number,
  ) {
    this.cache = new BoundedByteCache(maxEntryBytes, maxTotalBytes);
  }

  public watch(): vscode.Disposable {
    return new vscode.Disposable(() => undefined);
  }

  public async stat(uri: vscode.Uri): Promise<vscode.FileStat> {
    const bytes = await this.readFile(uri);
    return {
      type: vscode.FileType.File,
      ctime: FILE_MTIME,
      mtime: FILE_MTIME,
      size: bytes.byteLength,
      permissions: vscode.FilePermission.Readonly,
    };
  }

  public readDirectory(): [string, vscode.FileType][] {
    throw vscode.FileSystemError.NoPermissions(
      "Directory browsing is provided by the RepoShelf tree.",
    );
  }

  public createDirectory(): void {
    this.readOnly();
  }

  public async readFile(uri: vscode.Uri): Promise<Uint8Array> {
    try {
      const identity = parseRemoteFileIdentity(
        uri.authority,
        uri.path,
        uri.query,
      );
      const instance = this.instances
        .getInstances()
        .find((candidate) => candidate.instanceId === identity.instanceId);
      if (instance === undefined) {
        throw vscode.FileSystemError.FileNotFound("GitLab instance not found.");
      }
      const key = `${identity.instanceId}:${identity.projectId}:${identity.commitSha}:${identity.path}`;
      return await this.cache.getOrLoad(key, async () =>
        (await this.clients.create(instance)).getRawFile(
          identity.projectId,
          identity.commitSha,
          identity.path,
        ),
      );
    } catch (error) {
      if (error instanceof vscode.FileSystemError) throw error;
      if (error instanceof GitLabError && error.code === "notFound") {
        throw vscode.FileSystemError.FileNotFound(uri);
      }
      throw vscode.FileSystemError.Unavailable(
        error instanceof Error ? error.message : "Remote file is unavailable.",
      );
    }
  }

  public writeFile(): void {
    this.readOnly();
  }

  public delete(): void {
    this.readOnly();
  }

  public rename(): void {
    this.readOnly();
  }

  public clearCache(): void {
    this.cache.clear();
  }

  public dispose(): void {
    this.changed.dispose();
    this.cache.clear();
  }

  private readOnly(): never {
    throw vscode.FileSystemError.NoPermissions(
      "GitLab remote documents are read-only. Use Edit Locally in a later phase.",
    );
  }
}

export class RemoteDocumentStatus implements vscode.Disposable {
  private readonly item = vscode.window.createStatusBarItem(
    vscode.StatusBarAlignment.Right,
    100,
  );
  private readonly subscription = vscode.window.onDidChangeActiveTextEditor(
    (editor) => {
      this.update(editor);
    },
  );

  public constructor() {
    this.update(vscode.window.activeTextEditor);
  }

  public dispose(): void {
    this.subscription.dispose();
    this.item.dispose();
  }

  private update(editor: vscode.TextEditor | undefined): void {
    const uri = editor?.document.uri;
    if (uri?.scheme !== "reposhelffs") {
      this.item.hide();
      return;
    }
    try {
      const identity = parseRemoteFileIdentity(
        uri.authority,
        uri.path,
        uri.query,
      );
      const ref = identity.displayRef ?? "detached";
      this.item.text = `$(git-branch) ${ref} @ ${identity.commitSha.slice(0, 12)}`;
      this.item.tooltip = `Read-only GitLab document pinned to ${identity.commitSha}`;
      this.item.show();
    } catch {
      this.item.hide();
    }
  }
}
