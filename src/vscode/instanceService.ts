import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import path from "node:path";
import * as vscode from "vscode";
import { GitLabError } from "../domain/errors.js";
import {
  appendInstance,
  normalizeBaseUrl,
  parseInstances,
  removeInstanceById,
  resolveUserScopedValue,
} from "../domain/instance.js";
import type { GitLabInstance } from "../domain/models.js";

const CONFIGURATION_SECTION = "reposhelf";
const INSTANCES_KEY = "instances";
const CLONE_ROOT_KEY = "cloneRoot";

export class InstanceService {
  public constructor(
    private readonly onIgnoredWorkspaceSetting: (
      settingName: string,
    ) => void = () => undefined,
  ) {}

  public getInstances(): readonly GitLabInstance[] {
    return parseInstances(this.readUserScoped<unknown>(INSTANCES_KEY, []));
  }

  public getEnabledInstance(): GitLabInstance | undefined {
    return this.getEnabledInstances()[0];
  }

  public getEnabledInstances(): readonly GitLabInstance[] {
    return this.getInstances().filter((instance) => instance.enabled);
  }

  public getTimeoutMs(): number {
    const value = vscode.workspace
      .getConfiguration(CONFIGURATION_SECTION)
      .get<number>("api.timeoutMs", 30_000);
    return Math.min(120_000, Math.max(1_000, value));
  }

  public getMaxGetRetries(): number {
    const value = vscode.workspace
      .getConfiguration(CONFIGURATION_SECTION)
      .get<number>("api.maxGetRetries", 2);
    return Math.min(3, Math.max(0, Math.trunc(value)));
  }

  public getMaxFileCacheBytes(): number {
    const value = vscode.workspace
      .getConfiguration(CONFIGURATION_SECTION)
      .get<number>("cache.maxFileBytes", 5_242_880);
    return Math.min(20_971_520, Math.max(65_536, value));
  }

  public getMaxTotalCacheBytes(): number {
    const value = vscode.workspace
      .getConfiguration(CONFIGURATION_SECTION)
      .get<number>("cache.maxTotalBytes", 52_428_800);
    return Math.min(209_715_200, Math.max(1_048_576, value));
  }

  public getCloneRoot(): string {
    const configured = this.readUserScoped<unknown>(CLONE_ROOT_KEY, null);
    if (typeof configured === "string" && configured.trim() !== "")
      return configured.trim();
    return path.join(homedir(), "reposhelf-workspaces");
  }

  public async saveCloneRoot(cloneRoot: string): Promise<void> {
    await vscode.workspace
      .getConfiguration(CONFIGURATION_SECTION)
      .update(CLONE_ROOT_KEY, cloneRoot, vscode.ConfigurationTarget.Global);
  }

  public create(label: string, baseUrl: string): GitLabInstance {
    const normalizedBaseUrl = normalizeBaseUrl(baseUrl);
    if (
      this.getInstances().some(
        (instance) => instance.baseUrl === normalizedBaseUrl,
      )
    ) {
      throw new GitLabError(
        "configuration",
        "That GitLab instance is already configured.",
      );
    }
    const normalizedLabel = label.trim();
    if (normalizedLabel === "") {
      throw new GitLabError(
        "configuration",
        "Enter a label for the GitLab instance.",
      );
    }
    return {
      schemaVersion: 1,
      instanceId: randomUUID(),
      label: normalizedLabel,
      baseUrl: normalizedBaseUrl,
      enabled: true,
    };
  }

  public async save(instance: GitLabInstance): Promise<void> {
    await this.saveAll(appendInstance(this.getInstances(), instance));
  }

  public async remove(instanceId: string): Promise<void> {
    await this.saveAll(removeInstanceById(this.getInstances(), instanceId));
  }

  public async saveAll(instances: readonly GitLabInstance[]): Promise<void> {
    const validated = parseInstances(instances);
    await vscode.workspace
      .getConfiguration(CONFIGURATION_SECTION)
      .update(INSTANCES_KEY, validated, vscode.ConfigurationTarget.Global);
  }

  // Deliberately avoids `.get()`, which merges in workspace and folder values
  // that an opened repository controls.
  private readUserScoped<T>(key: string, fallback: T): T {
    const resolved = resolveUserScopedValue(
      vscode.workspace.getConfiguration(CONFIGURATION_SECTION).inspect<T>(key),
      fallback,
    );
    if (resolved.ignoredWorkspaceValue) {
      this.onIgnoredWorkspaceSetting(`${CONFIGURATION_SECTION}.${key}`);
    }
    return resolved.value;
  }
}
