import path from "node:path";
import { pathToFileURL } from "node:url";
import { access, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ManagedWorkspaceRecord } from "../src/domain/models.js";
import { NativeGitRunner } from "../src/infrastructure/gitRunner.js";
import {
  MaterializationService,
  type WorkspaceRegistry,
} from "../src/infrastructure/materialization.js";
import {
  WorkspaceReleaseService,
  type ReleaseRegistry,
  type WorkspaceRemover,
} from "../src/infrastructure/workspaceRelease.js";
import { WorkspaceSafetyCollector } from "../src/infrastructure/workspaceSafety.js";

class MemoryRegistry implements WorkspaceRegistry, ReleaseRegistry {
  public record: ManagedWorkspaceRecord | undefined;

  public getByLocalPath(localPath: string): ManagedWorkspaceRecord | undefined {
    return this.record?.localPath === localPath ? this.record : undefined;
  }

  public save(record: ManagedWorkspaceRecord): Promise<void> {
    this.record = record;
    return Promise.resolve();
  }

  public remove(workspaceId: string): Promise<void> {
    if (this.record?.workspaceId === workspaceId) this.record = undefined;
    return Promise.resolve();
  }
}

describe("WorkspaceReleaseService with a disposable Git remote", () => {
  const git = new NativeGitRunner();
  let root: string;
  let source: string;
  let remote: string;
  let record: ManagedWorkspaceRecord;
  let registry: MemoryRegistry;
  let service: WorkspaceReleaseService;

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), "reposhelf-release-"));
    source = path.join(root, "source");
    remote = path.join(root, "remote.git");
    await git.run(["init", "--initial-branch=main", source]);
    await configureUser(source);
    await writeFile(path.join(source, "README.md"), "initial\n");
    await git.run(["-C", source, "add", "--all"]);
    await commit(source, "initial");
    const head = (await git.run(["-C", source, "rev-parse", "HEAD"])).stdout;
    await git.run(["clone", "--bare", "--", source, remote]);
    registry = new MemoryRegistry();
    record = (
      await new MaterializationService(git, registry, true).materialize({
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
    await configureUser(record.localPath);
    service = new WorkspaceReleaseService(
      git,
      new WorkspaceSafetyCollector(git, true),
      registry,
    );
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("pushes committed work to the explicit branch and verifies exact equality", async () => {
    await writeFile(path.join(record.localPath, "change.txt"), "change\n");
    await git.run(["-C", record.localPath, "add", "change.txt"]);
    await commit(record.localPath, "change");

    const result = await service.push(record, 0);
    const remoteHead = (
      await git.run(["--git-dir", remote, "rev-parse", "refs/heads/main"])
    ).stdout;

    expect(result.decision).toEqual({ safe: true, blockers: [] });
    expect(result.snapshot.remoteTargetSha).toBe(result.snapshot.headSha);
    expect(remoteHead).toBe(result.snapshot.headSha);
  });

  it("does not push dirty work", async () => {
    const before = (
      await git.run(["--git-dir", remote, "rev-parse", "refs/heads/main"])
    ).stdout;
    await writeFile(path.join(record.localPath, "dirty.txt"), "dirty\n");

    const result = await service.push(record, 0);
    const after = (
      await git.run(["--git-dir", remote, "rev-parse", "refs/heads/main"])
    ).stdout;

    expect(result.decision.blockers.map(({ code }) => code)).toContain(
      "dirtyGit",
    );
    expect(after).toBe(before);
  });

  it("blocks release and preserves unclassified ignored content", async () => {
    const ignoredPath = path.join(record.localPath, ".env");
    await writeFile(
      path.join(record.localPath, ".git", "info", "exclude"),
      ".env\n",
    );
    await writeFile(ignoredPath, "SECRET=value\n");

    const assessment = await service.assessRelease(record, 0);

    expect(assessment.decision.blockers.map(({ code }) => code)).toContain(
      "ignoredContent",
    );
    await expect(
      service.prepareDeletion(record, assessment.snapshot.headSha, 0),
    ).rejects.toThrow("unclassified ignored item");
    await expect(access(ignoredPath)).resolves.toBeUndefined();
    expect(registry.record).toEqual(record);
  });

  it("does not push when another local branch contains unique commits", async () => {
    await git.run(["-C", record.localPath, "switch", "-c", "local-only"]);
    await writeFile(path.join(record.localPath, "unique.txt"), "unique\n");
    await git.run(["-C", record.localPath, "add", "unique.txt"]);
    await commit(record.localPath, "unique");
    await git.run(["-C", record.localPath, "switch", "main"]);

    const result = await service.push(record, 0);

    expect(result.decision.blockers.map(({ code }) => code)).toContain(
      "localOnlyRefs",
    );
  });

  it("deletes only after fresh proof and preserves the remote branch", async () => {
    const assessment = await service.assessRelease(record, 0);
    const capability = await service.prepareDeletion(
      record,
      assessment.snapshot.headSha,
      0,
    );

    await service.delete(capability, 0);

    await expect(access(record.localPath)).rejects.toMatchObject({
      code: "ENOENT",
    });
    expect(registry.record).toBeUndefined();
    await expect(
      git.run(["--git-dir", remote, "rev-parse", "refs/heads/main"]),
    ).resolves.toBeDefined();
  });

  it("rejects forged, expired, and reused deletion capabilities", async () => {
    await expect(
      service.delete(
        { workspaceId: record.workspaceId, canonicalPath: record.localPath },
        0,
      ),
    ).rejects.toThrow("fresh RepoShelf safety capability");

    let now = 1_000;
    const expiring = new WorkspaceReleaseService(
      git,
      new WorkspaceSafetyCollector(git, true),
      registry,
      () => now,
    );
    const assessment = await expiring.assessRelease(record, 0);
    const capability = await expiring.prepareDeletion(
      record,
      assessment.snapshot.headSha,
      0,
    );
    now = 31_001;
    await expect(expiring.delete(capability, 0)).rejects.toThrow("expired");
    await expect(expiring.delete(capability, 0)).rejects.toThrow(
      "fresh RepoShelf safety capability",
    );
  });

  it("checks a coordinated final authorization guard before native removal", async () => {
    let removed = false;
    const guarded = new WorkspaceReleaseService(
      git,
      new WorkspaceSafetyCollector(git, true),
      registry,
      Date.now,
      {
        remove: () => {
          removed = true;
          return Promise.resolve();
        },
        exists: () => Promise.resolve(true),
      },
    );
    const assessment = await guarded.assessRelease(record, 0);
    const capability = await guarded.prepareDeletion(
      record,
      assessment.snapshot.headSha,
      0,
      undefined,
      false,
      () => Promise.resolve(false),
    );

    await expect(guarded.deleteFilesystem(capability, 0)).rejects.toMatchObject(
      {
        code: "cancelled",
      },
    );
    expect(removed).toBe(false);
    expect(registry.record).toEqual(record);
  });

  it("retains the registry record when filesystem removal fails", async () => {
    const removalError = Object.assign(new Error("sensitive native detail"), {
      code: "EBUSY",
      syscall: "rmdir",
    });
    const failingRemover: WorkspaceRemover = {
      remove: () => Promise.reject(removalError),
      exists: () => Promise.resolve(true),
    };
    const failingService = new WorkspaceReleaseService(
      git,
      new WorkspaceSafetyCollector(git, true),
      registry,
      Date.now,
      failingRemover,
    );
    const assessment = await failingService.assessRelease(record, 0);
    const capability = await failingService.prepareDeletion(
      record,
      assessment.snapshot.headSha,
      0,
    );

    await expect(failingService.delete(capability, 0)).rejects.toThrow(
      "EBUSY during rmdir); its registry record was retained",
    );
    expect(registry.record).toEqual(record);
  });

  it("does not expose arbitrary native removal error text", async () => {
    const failingRemover: WorkspaceRemover = {
      remove: () => Promise.reject(new Error("sensitive native detail")),
      exists: () => Promise.resolve(true),
    };
    const failingService = new WorkspaceReleaseService(
      git,
      new WorkspaceSafetyCollector(git, true),
      registry,
      Date.now,
      failingRemover,
    );
    const assessment = await failingService.assessRelease(record, 0);
    const capability = await failingService.prepareDeletion(
      record,
      assessment.snapshot.headSha,
      0,
    );

    let failure: Error | undefined;
    try {
      await failingService.delete(capability, 0);
    } catch (error) {
      failure =
        error instanceof Error
          ? error
          : new Error("unexpected non-Error failure");
    }
    if (failure === undefined) throw new Error("Expected removal to fail.");
    expect(failure.message).toContain("unknown error");
    expect(failure.message).not.toContain("sensitive native detail");
    await expect(failingService.delete(capability, 0)).rejects.toThrow(
      "fresh RepoShelf safety capability",
    );
    expect(registry.record).toEqual(record);
  });

  it("blocks deletion when unsaved buffers appear after confirmation", async () => {
    const assessment = await service.assessRelease(record, 0);
    const capability = await service.prepareDeletion(
      record,
      assessment.snapshot.headSha,
      0,
    );

    await expect(service.delete(capability, 1)).rejects.toThrow(
      "Unsaved editor buffers appeared",
    );
    expect(registry.record).toEqual(record);
  });

  it("blocks deletion when HEAD changes after capability preparation", async () => {
    const assessment = await service.assessRelease(record, 0);
    const capability = await service.prepareDeletion(
      record,
      assessment.snapshot.headSha,
      0,
    );
    await writeFile(path.join(record.localPath, "late.txt"), "late\n");
    await git.run(["-C", record.localPath, "add", "late.txt"]);
    await commit(record.localPath, "late change");

    await expect(service.delete(capability, 0)).rejects.toThrow(
      "Workspace release is blocked",
    );
    expect(registry.record).toEqual(record);
    await expect(access(record.localPath)).resolves.toBeUndefined();
  });

  it("measures without following symlinks and supports cancellation", async () => {
    const outside = path.join(root, "outside-large.txt");
    const linked = path.join(record.localPath, "outside-link");
    await writeFile(outside, "x".repeat(1024 * 1024));
    await symlink(outside, linked, "file");

    const bytes = await service.measureWorkspaceBytes(record);
    expect(bytes).toBeLessThan(1024 * 1024);

    const controller = new AbortController();
    controller.abort();
    await expect(
      service.measureWorkspaceBytes(record, controller.signal),
    ).rejects.toMatchObject({ code: "cancelled" });
  });
});

async function configureUser(repository: string): Promise<void> {
  const git = new NativeGitRunner();
  await git.run(["-C", repository, "config", "user.name", "Test User"]);
  await git.run([
    "-C",
    repository,
    "config",
    "user.email",
    "test@example.invalid",
  ]);
}

async function commit(repository: string, message: string): Promise<void> {
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
