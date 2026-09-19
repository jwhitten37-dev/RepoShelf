import path from "node:path";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import type { ManagedWorkspaceRecord } from "../src/domain/models.js";
import { AuthoritativeWorkspaceRegistry } from "../src/infrastructure/authoritativeWorkspaceRegistry.js";
import { WorkspaceRegistryStore } from "../src/infrastructure/workspaceRegistryStore.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("AuthoritativeWorkspaceRegistry", () => {
  it("migrates, serves synchronous lookups, and mirrors authoritative saves", async () => {
    const root = await temporaryRoot();
    const mirrored: ManagedWorkspaceRecord[][] = [];
    const store = new WorkspaceRegistryStore(root, {
      replace: (records) => {
        mirrored.push([...records]);
        return Promise.resolve();
      },
    });
    const first = makeRecord(root, 1);
    const registry = await AuthoritativeWorkspaceRegistry.load(store, [first]);
    const second = makeRecord(root, 2);

    await registry.save(second);

    expect(registry.getByLocalPath(first.localPath)).toEqual(first);
    expect(registry.list()).toEqual([first, second]);
    expect(mirrored.at(-1)).toEqual([first, second]);
  });

  it("retains exact metadata while the workspace exists and removes after absence", async () => {
    const root = await temporaryRoot();
    const record = makeRecord(root, 1);
    await mkdir(record.localPath, { recursive: true });
    const store = new WorkspaceRegistryStore(root);
    const registry = await AuthoritativeWorkspaceRegistry.load(store, [record]);

    await expect(registry.removeVerified(record)).rejects.toMatchObject({
      code: "workspaceStillExists",
    });
    expect(registry.list()).toEqual([record]);

    await rm(record.localPath, { recursive: true });
    await registry.removeVerified(record);
    expect(registry.list()).toEqual([]);
  });
});

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "reposhelf-authority-test-"));
  roots.push(root);
  return root;
}

function makeRecord(root: string, identity: number): ManagedWorkspaceRecord {
  return {
    schemaVersion: 1,
    workspaceId: uuid(identity),
    instanceId: uuid(identity + 10),
    projectId: identity,
    projectPath: `group/project-${identity}`,
    canonicalRepositoryUrl: `https://gitlab.example.test/group/project-${identity}`,
    targetBranch: "main",
    pinnedCommitSha: identity.toString(16).padStart(40, "0"),
    cloneMode: "full",
    sparseDirectories: [],
    localPath: path.join(root, "managed", `workspace-${identity}`),
    cloneRoot: path.join(root, "managed"),
    revealPath: undefined,
    createdAt: new Date(0).toISOString(),
    lastOpenedAt: new Date(0).toISOString(),
  };
}

function uuid(value: number): string {
  return `${value.toString(16).padStart(8, "0")}-0000-4000-8000-000000000000`;
}
