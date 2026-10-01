import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  createLicenseInventory,
  RELEASE_TOOLING_LOCKFILE,
} from "../scripts/check-licenses.mjs";

const read = (file: string): string => readFileSync(file, "utf8");
const pipeline = read("azure-pipelines.yml");
const publishStage = pipeline.slice(pipeline.indexOf("- stage: Publish"));
const validateStage = pipeline.slice(0, pipeline.indexOf("- stage: Publish"));
const workflowDirectory = path.join(".github", "workflows");
const toolManifest = JSON.parse(read("tools/publish/package.json")) as {
  readonly private?: boolean;
  readonly dependencies?: Record<string, string>;
  readonly devDependencies?: Record<string, string>;
};

describe("release supply-chain isolation", () => {
  it("installs only the isolated publishing tool, without lifecycle scripts, in the publish stage", () => {
    expect(publishStage).not.toBe(pipeline);
    const installs = publishStage.match(/npm ci[^\n]*/gu) ?? [];
    expect(installs).toEqual([
      "npm ci --ignore-scripts --prefix tools/publish",
    ]);
    expect(publishStage).toContain(
      'vsce="tools/publish/node_modules/@vscode/vsce/vsce"',
    );
    expect(publishStage).not.toContain("npm exec");
  });

  it("verifies the isolated publishing tool before any tag can publish", () => {
    expect(validateStage).toContain(
      "npm ci --ignore-scripts --prefix tools/publish",
    );
    expect(validateStage).toContain(
      "npm audit --audit-level=high --prefix tools/publish",
    );
  });

  it("never persists repository credentials in pipeline checkouts", () => {
    expect(pipeline).not.toMatch(/persistCredentials:\s*true/u);
  });

  it("pins every GitHub Action to a full commit SHA with a version comment", () => {
    const uses = readdirSync(workflowDirectory)
      .filter((file) => file.endsWith(".yml"))
      .flatMap((file) =>
        read(path.join(workflowDirectory, file))
          .split("\n")
          .filter((line) => /^\s*-?\s*uses:/u.test(line)),
      );
    expect(uses.length).toBeGreaterThan(0);
    for (const line of uses) {
      expect(line).toMatch(/uses: [\w./-]+@[0-9a-f]{40} # v\d+\.\d+\.\d+$/u);
    }
  });

  it("declares exactly one exact-version publishing tool", () => {
    expect(toolManifest.private).toBe(true);
    expect(toolManifest.dependencies).toBeUndefined();
    expect(Object.keys(toolManifest.devDependencies ?? {})).toEqual([
      "@vscode/vsce",
    ]);
    expect(toolManifest.devDependencies?.["@vscode/vsce"]).toMatch(
      /^\d+\.\d+\.\d+$/u,
    );
  });

  it("holds the publishing tool lockfile to the license policy", () => {
    const inventory = createLicenseInventory(
      readFileSync(RELEASE_TOOLING_LOCKFILE),
      RELEASE_TOOLING_LOCKFILE,
    );
    expect(inventory.lockfile.fileName).toBe(RELEASE_TOOLING_LOCKFILE);
    expect(inventory.summary.production).toBe(0);
    expect(inventory.summary.directDevelopment).toBe(1);
  });

  it("keeps the publishing tool out of the extension package", () => {
    expect(read(".vscodeignore").split("\n")).toContain("tools/**");
  });
});
