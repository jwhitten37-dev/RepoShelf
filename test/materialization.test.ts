import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ManagedWorkspaceRecord } from "../src/domain/models.js";
import { NativeGitRunner } from "../src/infrastructure/gitRunner.js";
import {
  MaterializationService,
  placeWorkspace,
  type MaterializationRequest,
  type WorkspaceRegistry,
} from "../src/infrastructure/materialization.js";

class MemoryRegistry implements WorkspaceRegistry {
  public readonly records: ManagedWorkspaceRecord[] = [];

  public getByLocalPath(localPath: string): ManagedWorkspaceRecord | undefined {
    return this.records.find((record) => record.localPath === localPath);
  }

  public save(record: ManagedWorkspaceRecord): Promise<void> {
    const index = this.records.findIndex(
      (candidate) => candidate.localPath === record.localPath,
    );
    if (index === -1) this.records.push(record);
    else this.records[index] = record;
    return Promise.resolve();
  }
}

describe("MaterializationService with disposable local Git remotes", () => {
  let root: string;
  let source: string;
  let remote: string;
  let cloneRoot: string;
  let head: string;
  let registry: MemoryRegistry;
  let service: MaterializationService;
  const git = new NativeGitRunner();

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), "reposhelf-materialize-"));
    source = path.join(root, "source");
    remote = path.join(root, "remote.git");
    cloneRoot = path.join(root, "managed");
    await git.run(["init", "--initial-branch=main", source]);
    await git.run(["-C", source, "config", "user.name", "Test User"]);
    await git.run([
      "-C",
      source,
      "config",
      "user.email",
      "test@example.invalid",
    ]);
    await writeFixture(source);
    await git.run(["-C", source, "add", "--all"]);
    await git.run([
      "-C",
      source,
      "-c",
      "commit.gpgSign=false",
      "-c",
      "core.hooksPath=/dev/null",
      "commit",
      "-m",
      "fixture",
    ]);
    await git.run(["-C", source, "branch", "other-branch"]);
    await git.run(["-C", source, "-c", "tag.gpgSign=false", "tag", "v1.0.0"]);
    head = (await git.run(["-C", source, "rev-parse", "HEAD"])).stdout;
    await git.run(["clone", "--bare", "--", source, remote]);
    registry = new MemoryRegistry();
    service = new MaterializationService(git, registry, true);
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("creates and validates a full checkout with a private marker", async () => {
    const result = await service.materialize(
      request("full", [], "docs/guide.md"),
    );

    expect(result.reused).toBe(false);
    expect(
      (
        await stat(
          path.join(result.record.localPath, "src", "service", "app.txt"),
        )
      ).isFile(),
    ).toBe(true);
    expect(registry.records).toEqual([result.record]);
    const gitDir = (
      await git.run([
        "-C",
        result.record.localPath,
        "rev-parse",
        "--absolute-git-dir",
      ])
    ).stdout;
    const marker = JSON.parse(
      await readFile(path.join(gitDir, "reposhelf", "workspace.json"), "utf8"),
    ) as Record<string, unknown>;
    expect(marker.workspaceId).toBe(result.record.workspaceId);
    expect(marker.localPath).toBe(result.record.localPath);
    expect(
      await readFile(
        path.join(result.record.localPath, "docs", "guide.md"),
        "utf8",
      ),
    ).toBe("guide\n");
    expect(
      (
        await git.run([
          "-C",
          result.record.localPath,
          "show-ref",
          "--verify",
          "refs/remotes/origin/other-branch",
        ])
      ).stdout,
    ).toContain("refs/remotes/origin/other-branch");
    expect(
      (
        await git.run([
          "-C",
          result.record.localPath,
          "show-ref",
          "--verify",
          "refs/tags/v1.0.0",
        ])
      ).stdout,
    ).toContain("refs/tags/v1.0.0");
  });

  it("materializes selected cone directory plus root-level files", async () => {
    const result = await service.materialize(
      request("partialSparse", ["src/service"], "src/service/app.txt"),
    );

    expect(
      await readFile(
        path.join(result.record.localPath, "src", "service", "app.txt"),
        "utf8",
      ),
    ).toBe("app\n");
    expect(
      await readFile(path.join(result.record.localPath, "README.md"), "utf8"),
    ).toBe("root\n");
    await expect(
      stat(path.join(result.record.localPath, "docs", "guide.md")),
    ).rejects.toMatchObject({ code: "ENOENT" });
    expect(
      (
        await git.run([
          "-C",
          result.record.localPath,
          "sparse-checkout",
          "list",
        ])
      ).stdout,
    ).toBe("src/service");
    expect(
      (
        await git.run([
          "-C",
          result.record.localPath,
          "config",
          "--get",
          "remote.origin.partialclonefilter",
        ])
      ).stdout,
    ).toBe("blob:none");
  });

  it("materializes root-level files when the selected file is at repository root", async () => {
    const result = await service.materialize(
      request("partialSparse", [""], "README.md"),
    );

    expect(
      await readFile(path.join(result.record.localPath, "README.md"), "utf8"),
    ).toBe("root\n");
    await expect(
      stat(path.join(result.record.localPath, "src", "service", "app.txt")),
    ).rejects.toMatchObject({ code: "ENOENT" });
    expect(
      (
        await git.run([
          "-C",
          result.record.localPath,
          "sparse-checkout",
          "list",
        ])
      ).stdout,
    ).toBe("");
  });

  it("reuses only the validated extension-owned workspace", async () => {
    const first = await service.materialize(request("full", [], undefined));
    const second = await service.materialize(request("full", [], undefined));
    expect(second.reused).toBe(true);
    expect(second.record.workspaceId).toBe(first.record.workspaceId);
    expect(registry.records).toHaveLength(1);
  });

  it("creates a distinct local editable branch at the pinned source SHA", async () => {
    const result = await service.materialize({
      ...request("full", [], undefined),
      targetBranch: "feature/local-edit",
    });

    expect(result.record.targetBranch).toBe("feature/local-edit");
    expect(
      (
        await git.run([
          "-C",
          result.record.localPath,
          "symbolic-ref",
          "--short",
          "HEAD",
        ])
      ).stdout,
    ).toBe("feature/local-edit");
    expect(
      (await git.run(["-C", result.record.localPath, "rev-parse", "HEAD"]))
        .stdout,
    ).toBe(head);
    await expect(
      git.run([
        "--git-dir",
        remote,
        "show-ref",
        "--verify",
        "refs/heads/feature/local-edit",
      ]),
    ).rejects.toThrow();
  });

  it("blocks reuse when an existing sparse checkout lacks the requested scope", async () => {
    await service.materialize(
      request("partialSparse", ["src/service"], "src/service/app.txt"),
    );

    await expect(
      service.materialize(request("partialSparse", ["docs"], "docs/guide.md")),
    ).rejects.toThrow("does not contain the requested scope");
    await expect(
      service.materialize(request("full", [], undefined)),
    ).rejects.toThrow("does not contain the requested scope");
  });

  it("rolls back temporary artifacts when the branch moved", async () => {
    await expect(
      service.materialize({
        ...request("full", [], undefined),
        pinnedCommitSha: "f".repeat(40),
      }),
    ).rejects.toThrow("branch moved");

    const files = await recursiveNames(cloneRoot);
    expect(files.some((name) => name.includes(".tmp-"))).toBe(false);
    expect(files.some((name) => name.endsWith(".reposhelf-temp.json"))).toBe(
      false,
    );
    expect(registry.records).toHaveLength(0);
  });

  function request(
    cloneMode: "partialSparse" | "full",
    sparseDirectories: readonly string[],
    revealPath: string | undefined,
  ): MaterializationRequest {
    return {
      extensionSourceRoot: path.join(root, "extension-source"),
      cloneRoot,
      instanceId: "d48616b2-70ca-4fe0-91ac-d97e70a0de82",
      projectId: 842,
      projectPath: "platform/test-project",
      repositoryUrl: pathToFileURL(remote).href,
      sourceBranch: "main",
      targetBranch: "main",
      pinnedCommitSha: head,
      cloneMode,
      sparseDirectories,
      ...(revealPath === undefined ? {} : { revealPath }),
    };
  }
});

describe("Windows-safe workspace placement", () => {
  it("retries transient directory lock errors with bounded backoff", async () => {
    const errors = [windowsError("EPERM"), windowsError("EBUSY")];
    const renameCalls: [string, string][] = [];
    const delays: number[] = [];

    await placeWorkspace(
      "temporary",
      "final",
      undefined,
      (source, destination) => {
        renameCalls.push([source, destination]);
        const error = errors.shift();
        return error === undefined ? Promise.resolve() : Promise.reject(error);
      },
      (milliseconds) => {
        delays.push(milliseconds);
        return Promise.resolve();
      },
    );

    expect(renameCalls).toEqual([
      ["temporary", "final"],
      ["temporary", "final"],
      ["temporary", "final"],
    ]);
    expect(delays).toEqual([100, 200]);
  });

  it("fails immediately for a non-transient placement error", async () => {
    let attempts = 0;

    await expect(
      placeWorkspace(
        "temporary",
        "final",
        undefined,
        () => {
          attempts += 1;
          return Promise.reject(windowsError("EEXIST"));
        },
        () => Promise.resolve(),
      ),
    ).rejects.toMatchObject({ code: "EEXIST" });
    expect(attempts).toBe(1);
  });

  it("stops after eight transient placement attempts", async () => {
    let attempts = 0;
    const delays: number[] = [];

    await expect(
      placeWorkspace(
        "temporary",
        "final",
        undefined,
        () => {
          attempts += 1;
          return Promise.reject(windowsError("EBUSY"));
        },
        (milliseconds) => {
          delays.push(milliseconds);
          return Promise.resolve();
        },
      ),
    ).rejects.toMatchObject({ code: "EBUSY" });
    expect(attempts).toBe(8);
    expect(delays).toEqual([100, 200, 400, 800, 1_000, 1_000, 1_000]);
  });

  it("honors cancellation between placement attempts", async () => {
    const controller = new AbortController();
    let attempts = 0;

    setTimeout(() => {
      controller.abort();
    }, 10);

    await expect(
      placeWorkspace("temporary", "final", controller.signal, () => {
        attempts += 1;
        return Promise.reject(windowsError("EPERM"));
      }),
    ).rejects.toMatchObject({
      code: "cancelled",
      message: "Workspace materialization cancelled.",
    });
    expect(attempts).toBe(1);
  });
});

async function writeFixture(source: string): Promise<void> {
  await mkdir(path.join(source, "src", "service"), { recursive: true });
  await mkdir(path.join(source, "docs"), { recursive: true });
  await writeFile(path.join(source, "README.md"), "root\n");
  await writeFile(path.join(source, "src", "service", "app.txt"), "app\n");
  await writeFile(path.join(source, "docs", "guide.md"), "guide\n");
}

async function recursiveNames(candidate: string): Promise<string[]> {
  try {
    const entries = await readdir(candidate, { withFileTypes: true });
    const names: string[] = [];
    for (const entry of entries) {
      const child = path.join(candidate, entry.name);
      names.push(child);
      if (entry.isDirectory()) names.push(...(await recursiveNames(child)));
    }
    return names;
  } catch (error) {
    if (isNotFound(error)) return [];
    throw error;
  }
}

function isNotFound(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "ENOENT"
  );
}

function windowsError(code: string): NodeJS.ErrnoException {
  return Object.assign(new Error(`Windows filesystem error: ${code}`), {
    code,
  });
}
