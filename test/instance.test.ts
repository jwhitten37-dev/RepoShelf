import { describe, expect, it } from "vitest";
import { GitLabError } from "../src/domain/errors.js";
import {
  appendInstance,
  normalizeBaseUrl,
  parseInstances,
  removeInstanceById,
  resolveUserScopedValue,
} from "../src/domain/instance.js";
import type { GitLabInstance } from "../src/domain/models.js";

describe("normalizeBaseUrl", () => {
  it("normalizes a self-managed relative base path", () => {
    expect(normalizeBaseUrl(" https://gitlab.example.test/company/ ")).toBe(
      "https://gitlab.example.test/company",
    );
  });

  it.each([
    "http://gitlab.example.test",
    "https://user:password@gitlab.example.test",
    "https://gitlab.example.test?token=secret",
    "not a url",
  ])("rejects unsafe URL %s", (value) => {
    expect(() => normalizeBaseUrl(value)).toThrow(GitLabError);
  });

  it("permits loopback HTTP only when explicitly enabled", () => {
    expect(normalizeBaseUrl("http://localhost:8080/gitlab", true)).toBe(
      "http://localhost:8080/gitlab",
    );
    expect(() => normalizeBaseUrl("http://localhost:8080/gitlab")).toThrow(
      "must use HTTPS",
    );
  });
});

describe("parseInstances", () => {
  const instance = {
    schemaVersion: 1,
    instanceId: "d48616b2-70ca-4fe0-91ac-d97e70a0de82",
    label: "Company GitLab",
    baseUrl: "https://gitlab.example.test",
    enabled: true,
  };

  it("parses a valid instance", () => {
    expect(parseInstances([instance])).toEqual([instance]);
  });

  it("preserves multiple enabled instances and their stable IDs", () => {
    const second = {
      ...instance,
      instanceId: "b8c893ea-8c82-4cab-8a2e-10eb886dfbc1",
      label: "GitLab.com",
      baseUrl: "https://gitlab.com",
    };
    expect(parseInstances([instance, second])).toEqual([instance, second]);
  });

  it("rejects duplicate IDs even when one instance is disabled", () => {
    expect(() =>
      parseInstances([instance, { ...instance, enabled: false }]),
    ).toThrow("must be unique");
  });
});

describe("resolveUserScopedValue", () => {
  it("uses the user value and ignores workspace values", () => {
    expect(
      resolveUserScopedValue(
        { defaultValue: [], globalValue: ["user"], workspaceValue: ["repo"] },
        [],
      ),
    ).toEqual({ value: ["user"], ignoredWorkspaceValue: true });
  });

  it("never falls back to a workspace or folder value", () => {
    expect(
      resolveUserScopedValue<string | null>(
        { defaultValue: null, workspaceFolderValue: "/repo/root" },
        null,
      ),
    ).toEqual({ value: null, ignoredWorkspaceValue: true });
  });

  it("flags workspace language overrides as ignored", () => {
    expect(
      resolveUserScopedValue(
        { workspaceLanguageValue: "a", workspaceFolderLanguageValue: "b" },
        "fallback",
      ),
    ).toEqual({ value: "fallback", ignoredWorkspaceValue: true });
  });

  it("uses the contributed default, then the fallback", () => {
    expect(resolveUserScopedValue({ defaultValue: "default" }, "x")).toEqual({
      value: "default",
      ignoredWorkspaceValue: false,
    });
    expect(resolveUserScopedValue(undefined, "x")).toEqual({
      value: "x",
      ignoredWorkspaceValue: false,
    });
  });
});

describe("instance list mutations", () => {
  const first: GitLabInstance = {
    schemaVersion: 1,
    instanceId: "d48616b2-70ca-4fe0-91ac-d97e70a0de82",
    label: "First",
    baseUrl: "https://gitlab.example.test",
    enabled: true,
  };
  const second: GitLabInstance = {
    ...first,
    instanceId: "4b0f8f3c-1a2b-4c3d-8e4f-5a6b7c8d9e0f",
    label: "Second",
    baseUrl: "https://gitlab.second.example.test",
  };

  it("appends exactly one instance and preserves order", () => {
    expect(appendInstance([first], second)).toEqual([first, second]);
  });

  it.each([
    ["the same base URL", { ...second, baseUrl: first.baseUrl }],
    ["the same instance ID", { ...second, instanceId: first.instanceId }],
  ])("rejects an instance with %s", (_name, duplicate) => {
    expect(() => appendInstance([first], duplicate)).toThrow(
      "already configured",
    );
  });

  it("removes only the requested instance", () => {
    expect(removeInstanceById([first, second], first.instanceId)).toEqual([
      second,
    ]);
    expect(removeInstanceById([first], second.instanceId)).toEqual([first]);
  });
});
