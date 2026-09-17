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

function jsonResponse(value: unknown, headers: HeadersInit = {}): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { "content-type": "application/json", ...headers },
  });
}
