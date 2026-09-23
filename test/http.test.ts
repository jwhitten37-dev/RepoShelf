import { describe, expect, it, vi } from "vitest";
import { GitLabError } from "../src/domain/errors.js";
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

  it("retries transient GET failures with bounded exponential delays", async () => {
    const fetchMock = vi
      .fn<FetchLike>()
      .mockRejectedValueOnce(new TypeError("network unavailable"))
      .mockResolvedValueOnce(new Response(null, { status: 500 }))
      .mockResolvedValueOnce(jsonResponse({ id: 1 }));
    const sleep = vi.fn().mockResolvedValue(undefined);
    const client = new GitLabHttpClient({
      baseUrl: BASE_URL,
      token: "secret",
      timeoutMs: 1000,
      maxGetRetries: 2,
      fetch: fetchMock,
      sleep,
    });

    await expect(client.get("user")).resolves.toBeDefined();

    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(sleep).toHaveBeenNthCalledWith(1, 250, undefined);
    expect(sleep).toHaveBeenNthCalledWith(2, 500, undefined);
  });

  it("honors and caps Retry-After for retryable GET responses", async () => {
    const fetchMock = vi
      .fn<FetchLike>()
      .mockResolvedValueOnce(
        new Response(null, {
          status: 429,
          headers: { "retry-after": "120" },
        }),
      )
      .mockResolvedValueOnce(jsonResponse({ id: 1 }));
    const sleep = vi.fn().mockResolvedValue(undefined);
    const client = new GitLabHttpClient({
      baseUrl: BASE_URL,
      token: "secret",
      timeoutMs: 1000,
      maxGetRetries: 1,
      fetch: fetchMock,
      sleep,
    });

    await client.get("user");

    expect(sleep).toHaveBeenCalledOnce();
    expect(sleep).toHaveBeenCalledWith(30_000, undefined);
  });

  it("stops GET retries at the configured bound", async () => {
    const fetchMock = vi
      .fn<FetchLike>()
      .mockResolvedValue(new Response(null, { status: 503 }));
    const sleep = vi.fn().mockResolvedValue(undefined);
    const client = new GitLabHttpClient({
      baseUrl: BASE_URL,
      token: "secret",
      timeoutMs: 1000,
      maxGetRetries: 2,
      fetch: fetchMock,
      sleep,
    });

    await expect(client.get("user")).rejects.toMatchObject({ code: "server" });
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(sleep).toHaveBeenCalledTimes(2);
  });

  it.each([401, 403, 404])(
    "does not retry deterministic HTTP %i GET failures",
    async (status) => {
      const fetchMock = vi
        .fn<FetchLike>()
        .mockResolvedValue(new Response(null, { status }));
      const sleep = vi.fn().mockResolvedValue(undefined);
      const client = new GitLabHttpClient({
        baseUrl: BASE_URL,
        token: "secret",
        timeoutMs: 1000,
        maxGetRetries: 3,
        fetch: fetchMock,
        sleep,
      });

      await expect(client.get("user")).rejects.toBeDefined();
      expect(fetchMock).toHaveBeenCalledOnce();
      expect(sleep).not.toHaveBeenCalled();
    },
  );

  it("stops before redispatch when cancellation wins during GET backoff", async () => {
    const controller = new AbortController();
    const fetchMock = vi
      .fn<FetchLike>()
      .mockResolvedValue(new Response(null, { status: 503 }));
    const sleep = vi.fn().mockImplementation(() => {
      controller.abort();
      return Promise.reject(new GitLabError("cancelled", "Request cancelled."));
    });
    const client = new GitLabHttpClient({
      baseUrl: BASE_URL,
      token: "secret",
      timeoutMs: 1000,
      maxGetRetries: 3,
      fetch: fetchMock,
      sleep,
    });

    await expect(
      client.get("user", {}, controller.signal),
    ).rejects.toMatchObject({
      code: "cancelled",
    });
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("never retries POST when GET retries are enabled", async () => {
    const fetchMock = vi
      .fn<FetchLike>()
      .mockResolvedValue(new Response(null, { status: 503 }));
    const sleep = vi.fn().mockResolvedValue(undefined);
    const client = new GitLabHttpClient({
      baseUrl: BASE_URL,
      token: "secret",
      timeoutMs: 1000,
      maxGetRetries: 3,
      fetch: fetchMock,
      sleep,
    });

    await expect(
      client.postJson("projects/42/repository/branches", {
        branch: "feature/new",
        ref: "a".repeat(40),
      }),
    ).rejects.toMatchObject({ code: "server" });
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(sleep).not.toHaveBeenCalled();
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

  it("maps proxy authentication rejection without retrying", async () => {
    const fetchMock = vi
      .fn<FetchLike>()
      .mockResolvedValue(new Response(null, { status: 407 }));
    const sleep = vi.fn().mockResolvedValue(undefined);
    const client = new GitLabHttpClient({
      baseUrl: BASE_URL,
      token: "secret",
      timeoutMs: 1000,
      maxGetRetries: 3,
      fetch: fetchMock,
      sleep,
    });

    await expect(client.get("user")).rejects.toMatchObject({
      code: "proxyAuthentication",
    });
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(sleep).not.toHaveBeenCalled();
  });

  it.each([
    "CERT_NOT_YET_VALID",
    "CERT_HAS_EXPIRED",
    "CERT_SIGNATURE_FAILURE",
    "DEPTH_ZERO_SELF_SIGNED_CERT",
    "ERR_TLS_CERT_ALTNAME_INVALID",
    "SELF_SIGNED_CERT_IN_CHAIN",
    "UNABLE_TO_GET_ISSUER_CERT",
    "UNABLE_TO_GET_ISSUER_CERT_LOCALLY",
    "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
  ])("maps nested TLS error code %s without retrying", async (code) => {
    const fetchMock = vi.fn<FetchLike>().mockRejectedValue(
      new TypeError("fetch failed", {
        cause: new Error("TLS failed", { cause: { code } }),
      }),
    );
    const sleep = vi.fn().mockResolvedValue(undefined);
    const client = new GitLabHttpClient({
      baseUrl: BASE_URL,
      token: "secret",
      timeoutMs: 1000,
      maxGetRetries: 3,
      fetch: fetchMock,
      sleep,
    });

    await expect(client.get("user")).rejects.toMatchObject({ code: "tls" });
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(sleep).not.toHaveBeenCalled();
  });

  it("refuses API clients when Node TLS verification is disabled", () => {
    const original = process.env.NODE_TLS_REJECT_UNAUTHORIZED;
    process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
    try {
      expect(
        () =>
          new GitLabHttpClient({
            baseUrl: BASE_URL,
            token: "secret",
            timeoutMs: 1000,
            fetch: vi.fn<FetchLike>(),
          }),
      ).toThrow("refuses API requests");
    } finally {
      if (original === undefined)
        delete process.env.NODE_TLS_REJECT_UNAUTHORIZED;
      else process.env.NODE_TLS_REJECT_UNAUTHORIZED = original;
    }
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
