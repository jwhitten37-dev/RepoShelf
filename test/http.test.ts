import { describe, expect, it, vi } from "vitest";
import type { GitLabError } from "../src/domain/errors.js";
import {
  GitLabHttpClient,
  type FetchLike,
} from "../src/infrastructure/http.js";

const BASE_URL = "https://gitlab.example.test/company";

describe("GitLabHttpClient", () => {
  it("uses the relative API base and sends the PAT only as a header", async () => {
    const fetchMock = vi
      .fn<FetchLike>()
      .mockResolvedValue(jsonResponse({ id: 1 }));
    const client = new GitLabHttpClient({
      baseUrl: BASE_URL,
      token: "secret-token",
      timeoutMs: 1000,
      fetch: fetchMock,
    });

    await client.get("user");

    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(url?.toString()).toBe(
      "https://gitlab.example.test/company/api/v4/user",
    );
    expect(url?.toString()).not.toContain("secret-token");
    expect(new Headers(init?.headers).get("PRIVATE-TOKEN")).toBe(
      "secret-token",
    );
    expect(init?.redirect).toBe("manual");
  });

  it("follows an allowed same-origin API redirect", async () => {
    const fetchMock = vi
      .fn<FetchLike>()
      .mockResolvedValueOnce(
        new Response(null, {
          status: 302,
          headers: { location: `${BASE_URL}/api/v4/user?page=2` },
        }),
      )
      .mockResolvedValueOnce(jsonResponse({ id: 1 }));
    const client = new GitLabHttpClient({
      baseUrl: BASE_URL,
      token: "secret",
      timeoutMs: 1000,
      fetch: fetchMock,
    });

    await client.get("user");

    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("sends one authenticated JSON POST without credentials in the URL", async () => {
    const fetchMock = vi
      .fn<FetchLike>()
      .mockResolvedValue(jsonResponse({ name: "feature/new" }, {}, 201));
    const client = new GitLabHttpClient({
      baseUrl: BASE_URL,
      token: "secret-token",
      timeoutMs: 1000,
      fetch: fetchMock,
    });

    await client.postJson("projects/42/repository/branches", {
      branch: "feature/new",
      ref: "a".repeat(40),
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(url?.toString()).toBe(
      "https://gitlab.example.test/company/api/v4/projects/42/repository/branches",
    );
    expect(url?.toString()).not.toContain("secret-token");
    expect(init?.method).toBe("POST");
    expect(init?.redirect).toBe("manual");
    expect(new Headers(init?.headers).get("PRIVATE-TOKEN")).toBe(
      "secret-token",
    );
    expect(new Headers(init?.headers).get("Content-Type")).toBe(
      "application/json",
    );
    expect(init?.body).toBe(
      JSON.stringify({ branch: "feature/new", ref: "a".repeat(40) }),
    );
  });

  it("never follows or replays a POST redirect", async () => {
    const fetchMock = vi.fn<FetchLike>().mockResolvedValue(
      new Response(null, {
        status: 307,
        headers: {
          location:
            "https://gitlab.example.test/company/api/v4/projects/42/repository/branches",
        },
      }),
    );
    const client = new GitLabHttpClient({
      baseUrl: BASE_URL,
      token: "secret",
      timeoutMs: 1000,
      fetch: fetchMock,
    });

    await expect(
      client.postJson("projects/42/repository/branches", {
        branch: "feature/new",
        ref: "a".repeat(40),
      }),
    ).rejects.toMatchObject({ code: "writeUncertain" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("does not dispatch a POST when already cancelled", async () => {
    const fetchMock = vi.fn<FetchLike>();
    const client = new GitLabHttpClient({
      baseUrl: BASE_URL,
      token: "secret",
      timeoutMs: 1000,
      fetch: fetchMock,
    });
    const controller = new AbortController();
    controller.abort();

    await expect(
      client.postJson(
        "projects/42/repository/branches",
        { branch: "feature/new", ref: "a".repeat(40) },
        controller.signal,
      ),
    ).rejects.toMatchObject({ code: "cancelled" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects a cross-origin redirect before forwarding credentials", async () => {
    const fetchMock = vi.fn<FetchLike>().mockResolvedValue(
      new Response(null, {
        status: 302,
        headers: { location: "https://attacker.example/api/v4/user" },
      }),
    );
    const client = new GitLabHttpClient({
      baseUrl: BASE_URL,
      token: "secret",
      timeoutMs: 1000,
      fetch: fetchMock,
    });

    await expect(client.get("user")).rejects.toMatchObject<
      Partial<GitLabError>
    >({ code: "configuration" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("rejects a same-origin redirect outside the exact API path boundary", async () => {
    const fetchMock = vi.fn<FetchLike>().mockResolvedValue(
      new Response(null, {
        status: 302,
        headers: {
          location: "https://gitlab.example.test/company/api/v4-attacker/user",
        },
      }),
    );
    const client = new GitLabHttpClient({
      baseUrl: BASE_URL,
      token: "secret",
      timeoutMs: 1000,
      fetch: fetchMock,
    });

    await expect(client.get("user")).rejects.toMatchObject<
      Partial<GitLabError>
    >({ code: "configuration" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it.each([
    [401, "authentication"],
    [403, "authorization"],
    [404, "notFound"],
    [429, "rateLimited"],
    [500, "server"],
  ] as const)("maps HTTP %i to %s", async (status, code) => {
    const fetchMock = vi
      .fn<FetchLike>()
      .mockResolvedValue(new Response(null, { status }));
    const client = new GitLabHttpClient({
      baseUrl: BASE_URL,
      token: "secret",
      timeoutMs: 1000,
      fetch: fetchMock,
    });
    await expect(client.get("user")).rejects.toMatchObject({ code });
  });
});

function jsonResponse(
  value: unknown,
  headers: HeadersInit = {},
  status = 200,
): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}
