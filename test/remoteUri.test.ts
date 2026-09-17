import { describe, expect, it } from "vitest";
import {
  createRemoteFilePath,
  createRemoteFileQuery,
  normalizeRepositoryPath,
  parseRemoteFileIdentity,
} from "../src/domain/remoteUri.js";

const INSTANCE_ID = "d48616b2-70ca-4fe0-91ac-d97e70a0de82";
const SHA = "abcdef0123456789abcdef0123456789abcdef01";

describe("immutable remote file identity", () => {
  it("round-trips a path, branch, and full SHA", () => {
    const path = createRemoteFilePath(842, "docs/my file.md");
    const query = createRemoteFileQuery(SHA, "feature/upgrade");

    expect(parseRemoteFileIdentity(INSTANCE_ID, path, query)).toEqual({
      instanceId: INSTANCE_ID,
      projectId: 842,
      path: "docs/my file.md",
      commitSha: SHA,
      displayRef: "feature/upgrade",
    });
    expect(query).toBe(
      "commit=abcdef0123456789abcdef0123456789abcdef01&ref=feature%2Fupgrade",
    );
  });

  it.each([
    "../secret",
    "docs/../secret",
    "/absolute/file",
    "docs\\file",
    "docs//file",
    "docs/./file",
  ])("rejects unsafe repository path %s", (path) => {
    expect(() => normalizeRepositoryPath(path)).toThrow(
      "Invalid remote repository path",
    );
  });

  it("requires an immutable full SHA", () => {
    expect(() =>
      parseRemoteFileIdentity(
        INSTANCE_ID,
        "/projects/842/files/README.md",
        "commit=abc1234&ref=main",
      ),
    ).toThrow("Invalid immutable GitLab file URI");
  });

  it("rejects malformed authorities and project IDs", () => {
    expect(() =>
      parseRemoteFileIdentity(
        "gitlab.example.test",
        "/projects/0/files/README.md",
        `commit=${SHA}`,
      ),
    ).toThrow("Invalid immutable GitLab file URI");
  });
});
