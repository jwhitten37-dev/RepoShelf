import path from "node:path";
import { mkdtemp, mkdir, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import {
  allocateWorkspacePaths,
  assertStrictDescendant,
  normalizeRepositoryUrl,
  normalizeSparseDirectory,
  validateCloneRoot,
} from "../src/infrastructure/pathSafety.js";

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryRoots
      .splice(0)
      .map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("managed path safety", () => {
  it("allocates stable collision-safe descendants", async () => {
    const root = await temporaryRoot();
    const paths = allocateWorkspacePaths(
      root,
      "d48616b2-70ca-4fe0-91ac-d97e70a0de82",
      842,
      "platform/cluster bootstrap",
      "feature/upgrade-helm",
    );
    expect(path.relative(root, paths.finalPath)).not.toMatch(/^\.\./u);
    expect(paths.finalPath).toContain("842-cluster-bootstrap");
    expect(paths.finalPath).toMatch(/feature-upgrade-helm-[a-f0-9]{10}$/u);
    expect(paths.temporaryPath).not.toBe(paths.finalPath);
  });

  it("rejects roots, source overlap, and path escapes", async () => {
    const root = await temporaryRoot();
    await expect(
      validateCloneRoot(path.parse(root).root, root),
    ).rejects.toThrow("filesystem root");
    await expect(
      validateCloneRoot(path.join(root, "source", "managed"), root),
    ).rejects.toThrow("extension source folder");
    expect(() => {
      assertStrictDescendant(root, path.join(root, "..", "escape"));
    }).toThrow("escaped");
  });

  it("rejects a symlink component before creating the clone root", async () => {
    const root = await temporaryRoot();
    const target = path.join(root, "target");
    const linked = path.join(root, "linked");
    await mkdir(target);
    await symlink(target, linked, directoryLinkType());
    await expect(
      validateCloneRoot(
        path.join(linked, "managed"),
        path.join(root, "source"),
      ),
    ).rejects.toThrow("Linked path components");
  });

  it("normalizes sparse directories and rejects traversal", () => {
    expect(normalizeSparseDirectory("/src/service/")).toBe("src/service");
    expect(normalizeSparseDirectory("")).toBe("");
    expect(() => normalizeSparseDirectory("src/../secret")).toThrow(
      "Invalid sparse",
    );
  });

  it("accepts credential-free HTTPS and rejects embedded credentials", () => {
    expect(
      normalizeRepositoryUrl("https://gitlab.example.test/group/project.git"),
    ).toBe("https://gitlab.example.test/group/project");
    expect(() =>
      normalizeRepositoryUrl(
        "https://user:password@gitlab.example.test/group/project.git",
      ),
    ).toThrow("without embedded credentials");
  });
});

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "reposhelf-path-"));
  temporaryRoots.push(root);
  return root;
}

function directoryLinkType(): "dir" | "junction" {
  return process.platform === "win32" ? "junction" : "dir";
}
