import path from "node:path";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import type { ManagedWorkspaceRecord } from "../src/domain/models.js";
import {
  WorkspaceRegistryStore,
  type WorkspaceRegistryMirror,
} from "../src/infrastructure/workspaceRegistryStore.js";

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryRoots
      .splice(0)
      .map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("WorkspaceRegistryStore", () => {
  it("migrates legacy records once and does not reimport stale mirror state", async () => {
    const { store } = await createStore();
    const first = makeRecord(1);
    await store.initializeFromLegacy([first]);
    await expect(store.list()).resolves.toEqual([first]);

    await store.initializeFromLegacy([makeRecord(2)]);

    await expect(store.list()).resolves.toEqual([first]);
  });

  it("rejects conflicting legacy workspace IDs and paths", async () => {
    const { store } = await createStore();
    const first = makeRecord(1);
    await expect(
      store.initializeFromLegacy([
        first,
        { ...makeRecord(2), workspaceId: first.workspaceId },
      ]),
    ).rejects.toMatchObject({ code: "registryConflict" });
  });

  it("saves and reads independent workspace snapshots", async () => {
    const { store } = await createStore();
    await store.initializeFromLegacy([]);
    const first = makeRecord(1);
    const second = makeRecord(2);

    await Promise.all([store.save(first), store.save(second)]);

    await expect(store.list()).resolves.toEqual([first, second]);
    await expect(store.getByLocalPath(second.localPath)).resolves.toEqual(
      second,
    );
  });

  it("serializes same-workspace writers and never steals an existing lock", async () => {
    const { root, store } = await createStore();
    await store.initializeFromLegacy([]);
    const record = makeRecord(1);
    const lock = path.join(store.root, "locks", record.workspaceId);
    await mkdir(lock, { recursive: true });
    const contender = new WorkspaceRegistryStore(root);

    await expect(contender.save(record)).rejects.toMatchObject({
      code: "mutationBusy",
    });
    await expect(store.list()).resolves.toEqual([]);
  });

  it("rejects duplicate local paths across workspace snapshots", async () => {
    const { store } = await createStore();
    await store.initializeFromLegacy([]);
    const first = makeRecord(1);
    await store.save(first);

    await expect(
      store.save({
        ...makeRecord(2),
        localPath: first.localPath,
        cloneRoot: first.cloneRoot,
      }),
    ).rejects.toMatchObject({ code: "registryConflict" });
    await expect(store.list()).resolves.toEqual([first]);
  });

  it("allows only one concurrent allocation of the same local path", async () => {
    const { root, store } = await createStore();
    await store.initializeFromLegacy([]);
    const first = makeRecord(1);
    const second = {
      ...makeRecord(2),
      localPath: first.localPath,
      cloneRoot: first.cloneRoot,
    };
    const contender = new WorkspaceRegistryStore(root);

    const results = await Promise.allSettled([
      store.save(first),
      contender.save(second),
    ]);

    expect(results.filter(({ status }) => status === "fulfilled")).toHaveLength(
      1,
    );
    expect(results.filter(({ status }) => status === "rejected")).toHaveLength(
      1,
    );
    const records = await store.list();
    expect(records).toHaveLength(1);
    expect(records[0]?.localPath).toBe(first.localPath);
  });

  it("removes only an exact record after fresh absence verification", async () => {
    const { store } = await createStore();
    const first = makeRecord(1);
    const second = makeRecord(2);
    await store.initializeFromLegacy([first, second]);
    let verifiedPath: string | undefined;

    await store.removeVerified(first, (candidate) => {
      verifiedPath = candidate;
      return Promise.resolve(true);
    });

    expect(verifiedPath).toBe(first.localPath);
    await expect(store.list()).resolves.toEqual([second]);
  });

  it("retains registry state when the checkout exists or identity changed", async () => {
    const { store } = await createStore();
    const record = makeRecord(1);
    await store.initializeFromLegacy([record]);

    await expect(
      store.removeVerified(record, () => Promise.resolve(false)),
    ).rejects.toMatchObject({ code: "workspaceStillExists" });
    await expect(
      store.removeVerified({ ...record, targetBranch: "other" }, () =>
        Promise.resolve(true),
      ),
    ).rejects.toMatchObject({ code: "workspaceMismatch" });
    await expect(store.list()).resolves.toEqual([record]);
  });

  it("serializes verified removal with allocation of the same local path", async () => {
    const { store } = await createStore();
    const record = makeRecord(1);
    await store.initializeFromLegacy([record]);
    const normalized =
      process.platform === "win32"
        ? record.localPath.toLocaleLowerCase()
        : record.localPath;
    const lockName = createHash("sha256").update(normalized).digest("hex");
    await mkdir(path.join(store.root, "path-locks", lockName), {
      recursive: true,
    });

    await expect(
      store.removeVerified(record, () => Promise.resolve(true)),
    ).rejects.toMatchObject({ code: "mutationBusy" });
    await expect(store.list()).resolves.toEqual([record]);
  });

  it("reports mirror failure after preserving the committed snapshot", async () => {
    const mirror: WorkspaceRegistryMirror = {
      replace: () => Promise.reject(new Error("sensitive mirror failure")),
    };
    const { root, store } = await createStore(mirror);
    await store.initializeFromLegacy([]);
    const record = makeRecord(1);

    await expect(store.save(record)).rejects.toMatchObject({
      code: "mirrorFailed",
      committed: true,
    });
    await expect(new WorkspaceRegistryStore(root).list()).resolves.toEqual([
      record,
    ]);
  });

  it("ignores an abandoned update temporary file and preserves the committed snapshot", async () => {
    const { store } = await createStore();
    const record = makeRecord(1);
    await store.initializeFromLegacy([record]);
    await writeFile(
      path.join(
        store.root,
        "workspaces",
        record.workspaceId,
        ".record.aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa.tmp",
      ),
      JSON.stringify({ ...record, targetBranch: "uncommitted-change" }),
    );

    await expect(store.list()).resolves.toEqual([record]);
  });

  it("reconciles a mirror from filesystem snapshots without importing it", async () => {
    const captured: ManagedWorkspaceRecord[][] = [];
    const mirror: WorkspaceRegistryMirror = {
      replace: (records) => {
        captured.push([...records]);
        return Promise.resolve();
      },
    };
    const { store } = await createStore(mirror);
    const record = makeRecord(1);
    await store.initializeFromLegacy([record]);

    await store.reconcileMirror();

    expect(captured).toEqual([[record]]);
  });

  it("fails closed on malformed, moved, or linked snapshot storage", async () => {
    const { root, store } = await createStore();
    const record = makeRecord(1);
    await store.initializeFromLegacy([record]);
    const snapshot = path.join(
      store.root,
      "workspaces",
      record.workspaceId,
      "record.json",
    );
    await writeFile(snapshot, "not-json");
    await expect(store.list()).rejects.toMatchObject({ code: "invalidRecord" });

    const linkedRoot = path.join(root, "linked-root");
    const target = path.join(root, "linked-target");
    await mkdir(target);
    await symlink(target, linkedRoot, "dir");
    const linkedStore = new WorkspaceRegistryStore(linkedRoot);
    await expect(linkedStore.initializeFromLegacy([])).rejects.toMatchObject({
      code: "unsafeStorage",
    });
  });

  it("keeps an abandoned migration lock non-stealable", async () => {
    const { store } = await createStore();
    await mkdir(path.join(store.root, "migration-lock"), { recursive: true });

    await expect(store.initializeFromLegacy([])).rejects.toMatchObject({
      code: "mutationBusy",
    });
  });

  it("rejects malformed initialization and unexpected snapshot artifacts", async () => {
    const { store } = await createStore();
    await mkdir(store.root, { recursive: true });
    await writeFile(path.join(store.root, "initialized.json"), "{}");
    await expect(store.initializeFromLegacy([])).rejects.toMatchObject({
      code: "invalidRecord",
    });

    await rm(store.root, { recursive: true, force: true });
    const record = makeRecord(1);
    await store.initializeFromLegacy([record]);
    await writeFile(
      path.join(store.root, "workspaces", record.workspaceId, "unexpected.txt"),
      "unexpected",
    );
    await expect(store.list()).rejects.toMatchObject({ code: "unsafeStorage" });
  });

  it("rejects credential-bearing repository URLs", async () => {
    const { store } = await createStore();
    await store.initializeFromLegacy([]);

    await expect(
      store.save({
        ...makeRecord(1),
        canonicalRepositoryUrl:
          "https://user:secret@gitlab.example.test/group/project",
      }),
    ).rejects.toMatchObject({ code: "invalidRecord" });
  });
});

async function createStore(mirror?: WorkspaceRegistryMirror): Promise<{
  root: string;
  store: WorkspaceRegistryStore;
}> {
  const root = await mkdtemp(path.join(tmpdir(), "reposhelf-registry-"));
  temporaryRoots.push(root);
  return { root, store: new WorkspaceRegistryStore(root, mirror) };
}

function makeRecord(index: number): ManagedWorkspaceRecord {
  const cloneRoot = path.resolve("managed", `root-${index}`);
  return {
    schemaVersion: 1,
    workspaceId: uuid(index),
    instanceId: uuid(500),
    projectId: index,
    projectPath: `group/project-${index}`,
    canonicalRepositoryUrl: `https://gitlab.example.test/group/project-${index}`,
    targetBranch: "main",
    pinnedCommitSha: index.toString(16).padStart(40, "0"),
    cloneMode: "full",
    sparseDirectories: [],
    localPath: path.join(cloneRoot, "checkout"),
    cloneRoot,
    revealPath: undefined,
    createdAt: "2026-01-01T00:00:00.000Z",
    lastOpenedAt: "2026-01-01T00:00:00.000Z",
  };
}

function uuid(value: number): string {
  return `00000000-0000-4000-8000-${value.toString(16).padStart(12, "0")}`;
}
