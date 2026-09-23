import { describe, expect, it } from "vitest";
import { GitLabError } from "../src/domain/errors.js";
import { normalizeBaseUrl, parseInstances } from "../src/domain/instance.js";

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
