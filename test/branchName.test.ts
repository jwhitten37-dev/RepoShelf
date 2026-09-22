import { describe, expect, it } from "vitest";
import { validateBranchName } from "../src/domain/branchName.js";

describe("validateBranchName", () => {
  it.each(["feature/search", "release/2026.09", "user-name/topic_1", "a"])(
    "accepts %s",
    (branch) => {
      expect(validateBranchName(branch)).toBeUndefined();
    },
  );

  it.each([
    "",
    "@",
    "-danger",
    "/rooted",
    "trailing.",
    "trailing/",
    "double..dot",
    "reflog@{1}",
    "double//slash",
    "refs/item.lock",
    "space name",
    "question?",
    "back\\slash",
  ])("rejects %s", (branch) => {
    expect(validateBranchName(branch)).toBeDefined();
  });

  it("rejects names beyond the bounded input length", () => {
    expect(validateBranchName("a".repeat(256))).toContain("255");
  });
});
