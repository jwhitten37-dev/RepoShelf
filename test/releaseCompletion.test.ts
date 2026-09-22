import { describe, expect, it } from "vitest";
import {
  completedReleaseResult,
  projectReleaseCompletion,
  type ReleaseCompletionResult,
} from "../src/vscode/releaseCompletionProjection.js";
import { diskUsageLabel, formatBytes } from "../src/vscode/formatBytes.js";

describe("release completion presentation", () => {
  it("does not present retained outcomes as successful releases", () => {
    expect(
      projectReleaseCompletion(
        result(false, "notAttempted", "notAttempted"),
        true,
        true,
      ),
    ).toBeUndefined();
  });

  it("keeps normal coordinator completion concise", () => {
    expect(
      projectReleaseCompletion(
        completedReleaseResult("succeeded"),
        false,
        true,
      ),
    ).toEqual({
      severity: "information",
      message:
        "Local managed workspace released. The remote branch remains available in RepoShelf.",
      actions: [],
    });
  });

  it("offers remote browsing and safe closure only in a fallback host", () => {
    expect(
      projectReleaseCompletion(completedReleaseResult("succeeded"), true, true)
        ?.actions,
    ).toEqual(["Browse Remote", "Close Window"]);
    expect(
      projectReleaseCompletion(completedReleaseResult("succeeded"), true, false)
        ?.actions,
    ).toEqual(["Browse Remote"]);
  });

  it("reports catalog failure separately and offers retry without undoing release", () => {
    expect(
      projectReleaseCompletion(completedReleaseResult("failed"), false, false),
    ).toEqual({
      severity: "warning",
      message:
        "Local release succeeded; remote catalog refresh failed. The local checkout is already removed and will not be deleted again.",
      actions: ["Retry Catalog Refresh", "Show Output"],
    });
  });

  it("reports registry reconciliation independently", () => {
    const presentation = projectReleaseCompletion(
      result(true, "failed", "succeeded"),
      false,
      false,
    );
    expect(presentation?.severity).toBe("warning");
    expect(presentation?.actions).toEqual(["Show Output"]);
  });
});

describe("workspace byte formatting", () => {
  it("formats dashboard and confirmation sizes consistently", () => {
    expect(formatBytes(0)).toBe("0 B");
    expect(formatBytes(1024)).toBe("1.0 KB");
    expect(formatBytes(1536)).toBe("1.5 KB");
    expect(formatBytes(1024 ** 3)).toBe("1.0 GB");
  });

  it("projects every dashboard measurement state", () => {
    expect(diskUsageLabel(undefined)).toBe("Unavailable");
    expect(diskUsageLabel({ state: "measuring" })).toBe("Measuring…");
    expect(diskUsageLabel({ state: "unavailable" })).toBe("Unavailable");
    expect(
      diskUsageLabel({
        state: "available",
        usage: {
          worktreeBytes: 512,
          gitDirectoryBytes: 1024,
          totalBytes: 1536,
        },
      }),
    ).toBe("1.5 KB");
  });
});

function result(
  deletionVerified: boolean,
  registryReconciliation: ReleaseCompletionResult["registryReconciliation"],
  catalogRefresh: ReleaseCompletionResult["catalogRefresh"],
): ReleaseCompletionResult {
  return { deletionVerified, registryReconciliation, catalogRefresh };
}
