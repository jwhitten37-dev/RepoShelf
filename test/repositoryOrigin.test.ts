import { describe, expect, it } from "vitest";
import { GitLabError } from "../src/domain/errors.js";
import { compareRepositoryOrigin } from "../src/domain/repositoryOrigin.js";

describe("compareRepositoryOrigin", () => {
  it.each([
    [
      "the same host",
      "https://gitlab.example.test/group/project.git",
      "https://gitlab.example.test",
    ],
    [
      "a host differing only in case",
      "https://GitLab.Example.Test/group/project.git",
      "https://gitlab.example.test",
    ],
    [
      "an explicit default port",
      "https://gitlab.example.test:443/group/project.git",
      "https://gitlab.example.test",
    ],
    [
      "a project under the relative URL root",
      "https://example.test/gitlab/group/project.git",
      "https://example.test/gitlab",
    ],
    [
      "a relative URL root with a trailing slash",
      "https://example.test/gitlab/group/project.git",
      "https://example.test/gitlab/",
    ],
  ])("matches %s", (_name, repositoryUrl, instanceBaseUrl) => {
    expect(compareRepositoryOrigin(repositoryUrl, instanceBaseUrl)).toEqual({
      kind: "match",
    });
  });

  it.each([
    [
      "a different host",
      "https://other.example.test/group/project.git",
      "other.example.test",
    ],
    [
      "a lookalike suffix host",
      "https://gitlab.example.test.evil.test/group/project.git",
      "gitlab.example.test.evil.test",
    ],
    [
      "a different port",
      "https://gitlab.example.test:8443/group/project.git",
      "gitlab.example.test:8443",
    ],
  ])("rejects %s", (_name, repositoryUrl, repositoryHost) => {
    expect(
      compareRepositoryOrigin(repositoryUrl, "https://gitlab.example.test"),
    ).toEqual({
      kind: "mismatch",
      reason: "host",
      repositoryHost,
      instanceHost: "gitlab.example.test",
    });
  });

  it.each([
    "https://example.test/gitlab-evil/group/project.git",
    "https://example.test/group/project.git",
    "https://example.test/gitlab",
  ])("rejects %s outside the relative URL root", (repositoryUrl) => {
    expect(
      compareRepositoryOrigin(repositoryUrl, "https://example.test/gitlab"),
    ).toMatchObject({ kind: "mismatch", reason: "path" });
  });

  it.each([
    [
      "http://gitlab.example.test/group/project.git",
      "https://gitlab.example.test",
    ],
    ["not a url", "https://gitlab.example.test"],
    [
      "https://gitlab.example.test/group/project.git",
      "http://gitlab.example.test",
    ],
  ])("refuses non-HTTPS or invalid input %s", (repositoryUrl, base) => {
    expect(() => compareRepositoryOrigin(repositoryUrl, base)).toThrow(
      GitLabError,
    );
  });
});
