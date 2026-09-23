import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const read = (file: string): string => readFileSync(file, "utf8");
const manifest = JSON.parse(read("package.json")) as {
  scripts: Record<string, string>;
};
const publishing = read("docs/PUBLISHING.md");
const governance = read("docs/phase-7/RELEASE-GOVERNANCE-GATE.md");
const pipeline = read("azure-pipelines.yml");

describe("Phase 7 release governance", () => {
  it("runs the fail-closed license policy in the standard gate", () => {
    expect(manifest.scripts["license:check"]).toBe(
      "node scripts/check-licenses.mjs",
    );
    expect(manifest.scripts.check).toContain("npm run license:check");
  });

  it("documents immutable provenance without claiming a local signature", () => {
    expect(governance).toContain("does not create or claim a repository-local");
    expect(governance).toContain("SHA-256");
    expect(governance).toContain("downloads rather than rebuilds");
    expect(publishing).toContain(
      "independently compares its identity and SHA-256",
    );
  });

  it("revalidates retained evidence immediately before publishing", () => {
    expect(pipeline).toContain("Expected exactly one package evidence file");
    expect(pipeline).toContain("evidence.vsix.sha256 !== actual");
    expect(pipeline.indexOf("evidence.vsix.sha256 !== actual")).toBeLessThan(
      pipeline.indexOf("npm exec -- vsce publish"),
    );
    expect(pipeline).toContain(
      "npm exec -- vsce verify-pat chiefwizard --azure-credential",
    );
    expect(
      pipeline.indexOf("npm exec -- vsce verify-pat chiefwizard"),
    ).toBeLessThan(pipeline.indexOf("npm exec -- vsce publish"));
  });

  it("isolates the temporary Marketplace identity diagnostic from publication", () => {
    const diagnostic = pipeline.slice(
      pipeline.indexOf("- stage: DiagnoseMarketplaceIdentity"),
    );
    expect(diagnostic).toContain(
      "eq(variables['Build.SourceBranch'], 'refs/heads/main')",
    );
    expect(diagnostic).toContain(
      "https://app.vssps.visualstudio.com/_apis/profile/profiles/me",
    );
    expect(diagnostic).toContain("Marketplace profile ID:");
    expect(diagnostic).toContain(
      "npm exec -- vsce verify-pat chiefwizard --azure-credential",
    );
    expect(diagnostic).not.toContain("vsce publish");
    expect(diagnostic).not.toContain("package:vsix");
    expect(diagnostic).not.toContain("DownloadPipelineArtifact");
  });

  it("defines stable promotion, publisher recovery, and fix-forward rollback", () => {
    expect(governance).toContain("Stable promotion requires");
    expect(governance).toContain("phishing-resistant MFA");
    expect(governance).toContain("Marketplace versions are immutable");
    expect(governance).toContain("Fix forward");
    expect(governance).toContain(
      "do not claim that Marketplace can force-downgrade",
    );
  });
});
