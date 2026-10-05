import { describe, expect, it } from "vitest";
import {
  completedReleaseResult,
  projectReleaseCompletion,
  projectReleaseFailure,
  shouldCloseEmptyHost,
  type EmptyHostCloseInput,
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

describe("release failure presentation", () => {
  it.each([
    ["blocked", "was blocked by a safety check"],
    ["interrupted", "was interrupted"],
    ["failedRetained", "could not finish"],
  ] as const)("reports a %s outcome with the checkout kept", (kind, reason) => {
    expect(
      projectReleaseFailure(
        { outcome: kind, deletionVerified: false },
        "group/project",
      ),
    ).toEqual({
      message: `Release of group/project ${reason}. The local checkout was kept; review the RepoShelf output for details.`,
      actions: ["Show Output"],
    });
  });

  it("does not report verified releases as failures", () => {
    expect(
      projectReleaseFailure(
        { outcome: "completed", deletionVerified: true },
        "group/project",
      ),
    ).toBeUndefined();
  });
});

describe("empty host closing after a coordinator claim", () => {
  const coordinatorSessionId = "coordinator-session";
  const handedOff: EmptyHostCloseInput = {
    role: "detached",
    acknowledgedOperationId: "operation-1",
    operation: {
      operationId: "operation-1",
      request: { coordinatorSessionId },
      claim: {
        claimantRole: "coordinator",
        claimantSessionId: coordinatorSessionId,
      },
    },
    canCloseWindow: true,
    closeEnabled: true,
  };

  it("closes once the requesting coordinator holds the claim", () => {
    expect(shouldCloseEmptyHost(handedOff)).toBe(true);
  });

  it.each([
    ["the window has content to lose", { canCloseWindow: false }],
    ["the user disabled closing", { closeEnabled: false }],
    ["this host is the coordinator", { role: "coordinator" as const }],
    [
      "this host acknowledged another release",
      {
        acknowledgedOperationId: "operation-2",
      },
    ],
    ["this host acknowledged nothing", { acknowledgedOperationId: undefined }],
    [
      "nobody has claimed yet",
      {
        operation: {
          operationId: "operation-1",
          request: { coordinatorSessionId },
        },
      },
    ],
    [
      "this host claimed it as the fallback",
      {
        operation: {
          ...handedOff.operation,
          claim: {
            claimantRole: "detached" as const,
            claimantSessionId: "detached-session",
          },
        },
      },
    ],
    [
      "a different coordinator claimed it",
      {
        operation: {
          ...handedOff.operation,
          claim: {
            claimantRole: "coordinator" as const,
            claimantSessionId: "other-coordinator",
          },
        },
      },
    ],
  ] satisfies [string, Partial<EmptyHostCloseInput>][])(
    "stays open when %s",
    (_name, change) => {
      expect(shouldCloseEmptyHost({ ...handedOff, ...change })).toBe(false);
    },
  );
});
