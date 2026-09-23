import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

interface Manifest {
  readonly description: string;
  readonly displayName: string;
  readonly keywords: readonly string[];
  readonly publisher: string;
  readonly name: string;
  readonly private?: boolean;
}

const root = process.cwd();
const read = (file: string): string =>
  readFileSync(path.join(root, file), "utf8");
const readme = read("README.md");
const privacy = read("docs/PRIVACY.md");
const changelog = read("CHANGELOG.md");
const manifest = JSON.parse(read("package.json")) as Manifest;

describe("Phase 7 Marketplace listing", () => {
  it("publishes the reviewed provider-neutral identity and discoverability metadata", () => {
    expect(`${manifest.publisher}.${manifest.name}`).toBe(
      "chiefwizard.reposhelf",
    );
    expect(manifest.displayName).toBe("RepoShelf");
    expect(manifest.description).toContain(
      "Browse GitLab repositories remotely",
    );
    expect(manifest.keywords).toEqual(
      expect.arrayContaining([
        "gitlab",
        "repository browser",
        "sparse checkout",
        "workspace management",
      ]),
    );
    expect(manifest.keywords.length).toBeLessThanOrEqual(30);
    expect(manifest.private).toBeUndefined();
  });

  it("describes current capabilities without stale implementation-phase claims", () => {
    expect(readme).toContain("Connect to multiple GitLab instances");
    expect(readme).toContain(
      "Create a remote branch from an exact source commit",
    );
    expect(readme).toContain("Local Workspaces");
    expect(readme).not.toMatch(/Phase 4 implementation|Phase 4\.1.*planned/iu);
  });

  it("states the MVP limitations and screenshot-independent privacy posture", () => {
    expect(readme).toContain("OAuth is not implemented");
    expect(readme).toContain("Merge-request creation");
    expect(readme).toContain("no persistent offline");
    expect(readme).toContain("cannot be expanded in place");
    expect(read("docs/BRANDING.md")).toContain(
      "screenshots are intentionally omitted",
    );
  });

  it("discloses credential, network, persistence, deletion, and telemetry behavior", () => {
    for (const statement of [
      "SecretStorage",
      "Git credential helper",
      "Extension global storage",
      "Remote file cache",
      "No telemetry",
      "User controls and deletion",
    ]) {
      expect(privacy).toContain(statement);
    }
    expect(readme).toContain("privacy and data-handling disclosure");
  });

  it("records completed Phase 6 and 7 release-facing changes", () => {
    expect(changelog).toContain("Multiple independently authenticated GitLab");
    expect(changelog).toContain("remote branch creation");
    expect(changelog).toContain("Deterministic cross-platform VSIX packaging");
  });
});
