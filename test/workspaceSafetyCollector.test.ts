import path from "node:path";
import { pathToFileURL } from "node:url";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ManagedWorkspaceRecord } from "../src/domain/models.js";
import { NativeGitRunner } from "../src/infrastructure/gitRunner.js";
import {
  MaterializationService,
  type WorkspaceRegistry,
} from "../src/infrastructure/materialization.js";
import { WorkspaceSafetyCollector } from "../src/infrastructure/workspaceSafety.js";

class MemoryRegistry implements WorkspaceRegistry {
  public record: ManagedWorkspaceRecord | undefined;

  public getByLocalPath(localPath: string): ManagedWorkspaceRecord | undefined {
    return this.record?.localPath === localPath ? this.record : undefined;
  }

  public save(record: ManagedWorkspaceRecord): Promise<void> {
    this.record = record;
    return Promise.resolve();
  }
}

describe("WorkspaceSafetyCollector with a disposable Git remote", () => {
  const git = new NativeGitRunner();
  const collector = new WorkspaceSafetyCollector(git, true);
  let root: string;
  let source: string;
  let remote: string;
  let record: ManagedWorkspaceRecord;

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), "reposhelf-safety-"));
    source = path.join(root, "source");
    remote = path.join(root, "remote.git");
    await git.run(["init", "--initial-branch=main", source]);
    await git.run(["-C", source, "config", "user.name", "Test User"]);
    await git.run([
      "-C",
      source,
      "config",
      "user.email",
      "test@example.invalid",
    ]);
    await writeFile(path.join(source, "README.md"), "initial\n");
    await git.run(["-C", source, "add", "--all"]);
    await commit(source, "initial");
    const head = (await git.run(["-C", source, "rev-parse", "HEAD"])).stdout;
    await git.run(["clone", "--bare", "--", source, remote]);
    const registry = new MemoryRegistry();
    const materialization = new MaterializationService(git, registry, true);
    record = (
      await materialization.materialize({
        extensionSourceRoot: path.join(root, "extension-source"),
        cloneRoot: path.join(root, "managed"),
        instanceId: "11111111-1111-4111-8111-111111111111",
        projectId: 42,
        projectPath: "group/project",
        repositoryUrl: pathToFileURL(remote).toString(),
        sourceBranch: "main",
        targetBranch: "main",
        pinnedCommitSha: head,
        cloneMode: "full",
        sparseDirectories: [],
      })
    ).record;
    await git.run(["-C", record.localPath, "config", "user.name", "Test User"]);
    await git.run([
      "-C",
      record.localPath,
      "config",
      "user.email",
      "test@example.invalid",
    ]);
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("collects a complete clean snapshot", async () => {
    const snapshot = await collector.collect(record);

    expect(snapshot.branch).toBe("main");
    expect(snapshot.statusEntryCount).toBe(0);
    expect(snapshot.ignoredGeneratedEntryCount).toBe(0);
    expect(snapshot.ignoredUnclassifiedEntryCount).toBe(0);
    expect(snapshot.operationStates).toEqual([]);
    expect(snapshot.remoteTargetSha).toBe(snapshot.headSha);
    expect(snapshot.headAheadOfRemoteTarget).toBe(0);
    expect(snapshot.localOnlyRefCount).toBe(0);
  });

  it("separates generated and unclassified ignored content", async () => {
    await writeFile(
      path.join(record.localPath, ".git", "info", "exclude"),
      ["node_modules/", ".env", "*.sqlite", "*.pem", "local-notes/", ""].join(
        "\n",
      ),
    );
    await mkdir(path.join(record.localPath, "node_modules", "package"), {
      recursive: true,
    });
    await mkdir(path.join(record.localPath, "local-notes"));
    await Promise.all([
      writeFile(
        path.join(record.localPath, "node_modules", "package", "index.js"),
        "generated\n",
      ),
      writeFile(path.join(record.localPath, ".env"), "SECRET=value\n"),
      writeFile(path.join(record.localPath, "local.sqlite"), "database\n"),
      writeFile(path.join(record.localPath, "private.pem"), "private key\n"),
      writeFile(
        path.join(record.localPath, "local-notes", "todo.txt"),
        "note\n",
      ),
    ]);

    const snapshot = await collector.collect(record);

    expect(snapshot.statusEntryCount).toBe(0);
    expect(snapshot.ignoredGeneratedEntryCount).toBe(1);
    expect(snapshot.ignoredUnclassifiedEntryCount).toBe(4);
  });

  it("detects dirty state and an ongoing Git operation", async () => {
    await writeFile(path.join(record.localPath, "untracked.txt"), "local\n");
    await writeFile(
      path.join(record.localPath, ".git", "MERGE_HEAD"),
      "a".repeat(40),
    );

    const snapshot = await collector.collect(record);

    expect(snapshot.statusEntryCount).toBe(1);
    expect(snapshot.operationStates).toContain("merge");
  });

  it("detects a local-only branch ref", async () => {
    await writeFile(path.join(record.localPath, "local.txt"), "local\n");
    await git.run(["-C", record.localPath, "add", "local.txt"]);
    await commit(record.localPath, "local");
    await git.run(["-C", record.localPath, "branch", "local-only"]);
    await git.run(["-C", record.localPath, "reset", "--hard", "origin/main"]);

    const snapshot = await collector.collect(record);

    expect(snapshot.statusEntryCount).toBe(0);
    expect(snapshot.localOnlyRefCount).toBe(1);
  });

  it("rejects a marker that disagrees with the registry", async () => {
    const markerPath = path.join(
      record.localPath,
      ".git",
      "reposhelf",
      "workspace.json",
    );
    const marker = JSON.parse(await readFile(markerPath, "utf8")) as Record<
      string,
      unknown
    >;
    marker.projectId = 99;
    await writeFile(markerPath, `${JSON.stringify(marker)}\n`);

    await expect(collector.collect(record)).rejects.toThrow(
      "Registry and ownership marker",
    );
  });

  it("rejects an altered origin before attempting a fetch", async () => {
    const nonexistentRemote = pathToFileURL(
      path.join(root, "does-not-exist.git"),
    ).toString();
    await git.run([
      "-C",
      record.localPath,
      "remote",
      "set-url",
      "origin",
      nonexistentRemote,
    ]);

    await expect(collector.collect(record)).rejects.toThrow(
      "origin does not match",
    );
  });

  it("rejects a checkout outside its recorded clone root", async () => {
    await mkdir(path.join(root, "other-root"));
    await expect(
      collector.collect({
        ...record,
        cloneRoot: path.join(root, "other-root"),
      }),
    ).rejects.toThrow("escaped");
  });
});

async function commit(repository: string, message: string): Promise<void> {
  await gitForCommit(repository, message);
}

async function gitForCommit(
  repository: string,
  message: string,
): Promise<void> {
  const git = new NativeGitRunner();
  await git.run([
    "-C",
    repository,
    "-c",
    "commit.gpgSign=false",
    "-c",
    "core.hooksPath=/dev/null",
    "commit",
    "-m",
    message,
  ]);
}
