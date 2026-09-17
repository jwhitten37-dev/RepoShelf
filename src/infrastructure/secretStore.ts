import type * as vscode from "vscode";

export interface TokenStore {
  get(instanceId: string): Promise<string | undefined>;
  set(instanceId: string, token: string): Promise<void>;
  delete(instanceId: string): Promise<void>;
}

export class VsCodeTokenStore implements TokenStore {
  public constructor(private readonly secrets: vscode.SecretStorage) {}

  public get(instanceId: string): Promise<string | undefined> {
    return Promise.resolve(this.secrets.get(secretKey(instanceId)));
  }

  public set(instanceId: string, token: string): Promise<void> {
    return Promise.resolve(this.secrets.store(secretKey(instanceId), token));
  }

  public delete(instanceId: string): Promise<void> {
    return Promise.resolve(this.secrets.delete(secretKey(instanceId)));
  }
}

function secretKey(instanceId: string): string {
  return `reposhelf.instance.${instanceId}.pat`;
}
