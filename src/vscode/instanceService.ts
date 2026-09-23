import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import path from "node:path";
import * as vscode from "vscode";
import { GitLabError } from "../domain/errors.js";
import { normalizeBaseUrl, parseInstances } from "../domain/instance.js";
import type { GitLabInstance } from "../domain/models.js";

const CONFIGURATION_SECTION = "reposhelf";
const INSTANCES_KEY = "instances";

export class InstanceService {
  public getInstances(): readonly GitLabInstance[] {
    const value = vscode.workspace
      .getConfiguration(CONFIGURATION_SECTION)
      .get<unknown>(INSTANCES_KEY, []);
    return parseInstances(value);
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
    const configured = vscode.workspace
      .getConfiguration(CONFIGURATION_SECTION)
      .get<string | null>("cloneRoot", null);
    if (configured !== null && configured.trim() !== "")
      return configured.trim();
    return path.join(homedir(), "reposhelf-workspaces");
  }

  public async saveCloneRoot(cloneRoot: string): Promise<void> {
    await vscode.workspace
      .getConfiguration(CONFIGURATION_SECTION)
      .update("cloneRoot", cloneRoot, vscode.ConfigurationTarget.Global);
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
    await this.saveAll([...this.getInstances(), instance]);
  }

  public async remove(instanceId: string): Promise<void> {
    await this.saveAll(
      this.getInstances().filter(
        (instance) => instance.instanceId !== instanceId,
      ),
    );
  }

  public async saveAll(instances: readonly GitLabInstance[]): Promise<void> {
    const validated = parseInstances(instances);
    await vscode.workspace
      .getConfiguration(CONFIGURATION_SECTION)
      .update(INSTANCES_KEY, validated, vscode.ConfigurationTarget.Global);
  }
}
