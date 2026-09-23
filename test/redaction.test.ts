import { describe, expect, it } from "vitest";
import { redactText, redactUnknown } from "../src/infrastructure/redaction.js";

describe("redaction", () => {
  it("redacts GitLab tokens and sensitive headers", () => {
    const input = "PRIVATE-TOKEN: glpat-superSecret Authorization=BearerSecret";
    const output = redactText(input);
    expect(output).not.toContain("superSecret");
    expect(output).not.toContain("BearerSecret");
    expect(output).toContain("[REDACTED]");
  });

  it("redacts URL user information", () => {
    expect(
      redactText("https://user:pass@gitlab.example.test/group/project.git"),
    ).toBe("https://[REDACTED]@gitlab.example.test/group/project.git");
  });

  it("redacts sensitive object keys", () => {
    const output = redactUnknown({
      username: "user",
      token: "plain-secret",
      nested: { password: "password" },
    });
    expect(output).not.toContain("plain-secret");
    expect(output).not.toContain('"password":"password"');
  });

  it("redacts proxy credentials in headers, URLs, and objects", () => {
    const output = redactText(
      "Proxy-Authorization: Basic-secret https://proxy-user:proxy-pass@proxy.example.test",
    );
    expect(output).not.toContain("Basic-secret");
    expect(output).not.toContain("proxy-user");
    expect(output).not.toContain("proxy-pass");
    expect(
      redactUnknown({
        "proxy-authorization": "secret",
        proxyPassword: "secret",
      }),
    ).not.toContain('"secret"');
  });
});
