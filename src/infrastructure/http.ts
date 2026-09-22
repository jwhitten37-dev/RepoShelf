import { GitLabError } from "../domain/errors.js";

export interface HttpResponse {
  readonly status: number;
  readonly headers: Headers;
  json(): Promise<unknown>;
  text(): Promise<string>;
  bytes(): Promise<Uint8Array>;
}

export type FetchLike = (
  input: string | URL,
  init?: RequestInit,
) => Promise<Response>;

export interface GitLabHttpClientOptions {
  readonly baseUrl: string;
  readonly token: string;
  readonly timeoutMs: number;
  readonly fetch?: FetchLike;
}

export class GitLabHttpClient {
  private readonly apiBaseUrl: URL;
  private readonly expectedOrigin: string;
  private readonly fetchImplementation: FetchLike;

  public constructor(private readonly options: GitLabHttpClientOptions) {
    const normalizedBase = new URL(`${options.baseUrl.replace(/\/+$/u, "")}/`);
    this.apiBaseUrl = new URL("api/v4/", normalizedBase);
    this.expectedOrigin = normalizedBase.origin;
    this.fetchImplementation = options.fetch ?? fetch;
  }

  public async get(
    path: string,
    query: Readonly<Record<string, string>> = {},
    signal?: AbortSignal,
  ): Promise<HttpResponse> {
    const url = this.createApiUrl(path, query);
    return this.request(url, {
      method: "GET",
      ...(signal === undefined ? {} : { signal }),
      redirectCount: 0,
    });
  }

  public async getAbsolute(
    url: URL,
    signal?: AbortSignal,
  ): Promise<HttpResponse> {
    this.assertAllowedApiUrl(url);
    return this.request(url, {
      method: "GET",
      ...(signal === undefined ? {} : { signal }),
      redirectCount: 0,
    });
  }

  public async postJson(
    path: string,
    body: Readonly<Record<string, string>>,
    signal?: AbortSignal,
  ): Promise<HttpResponse> {
    const url = this.createApiUrl(path, {});
    return this.request(url, {
      method: "POST",
      body: JSON.stringify(body),
      ...(signal === undefined ? {} : { signal }),
      redirectCount: 0,
    });
  }

  private createApiUrl(
    path: string,
    query: Readonly<Record<string, string>>,
  ): URL {
    if (path.startsWith("/") || path.includes("..")) {
      throw new GitLabError(
        "configuration",
        "An invalid GitLab API path was requested.",
      );
    }
    const url = new URL(path, this.apiBaseUrl);
    this.assertAllowedApiUrl(url);
    for (const [key, value] of Object.entries(query)) {
      url.searchParams.set(key, value);
    }
    return url;
  }

  private assertAllowedApiUrl(url: URL): void {
    const apiPath = this.apiBaseUrl.pathname;
    if (
      url.origin !== this.expectedOrigin ||
      (url.pathname !== apiPath.slice(0, -1) &&
        !url.pathname.startsWith(apiPath))
    ) {
      throw new GitLabError(
        "configuration",
        "Refused to send GitLab credentials outside the configured API origin.",
      );
    }
  }

  private async request(
    url: URL,
    options: {
      readonly method: "GET" | "POST";
      readonly body?: string;
      readonly signal?: AbortSignal;
      readonly redirectCount: number;
    },
  ): Promise<HttpResponse> {
    this.assertAllowedApiUrl(url);
    if (options.signal?.aborted === true) {
      throw new GitLabError("cancelled", "Request cancelled.");
    }
    const timeoutController = new AbortController();
    const timeout = setTimeout(() => {
      timeoutController.abort(new Error("request timed out"));
    }, this.options.timeoutMs);
    const signal = combineSignals(options.signal, timeoutController.signal);

    try {
      const response = await this.fetchImplementation(url, {
        method: options.method,
        headers: {
          Accept: "application/json",
          ...(options.method === "POST"
            ? { "Content-Type": "application/json" }
            : {}),
          "PRIVATE-TOKEN": this.options.token,
          "User-Agent": "GitLab-On-Demand-VS-Code",
        },
        redirect: "manual",
        signal,
        ...(options.body === undefined ? {} : { body: options.body }),
      });

      if (response.status >= 300 && response.status < 400) {
        if (options.method === "POST") {
          throw new GitLabError(
            "writeUncertain",
            "GitLab redirected a remote write; RepoShelf did not replay it.",
            { status: response.status },
          );
        }
        if (options.redirectCount >= 5) {
          throw new GitLabError(
            "invalidResponse",
            "GitLab returned too many redirects.",
          );
        }
        const location = response.headers.get("location");
        if (location === null) {
          throw new GitLabError(
            "invalidResponse",
            "GitLab returned a redirect without a location.",
            {
              status: response.status,
            },
          );
        }
        const redirectUrl = new URL(location, url);
        this.assertAllowedApiUrl(redirectUrl);
        return this.request(redirectUrl, {
          ...options,
          redirectCount: options.redirectCount + 1,
        });
      }

      if (!response.ok) {
        throw mapHttpStatus(response.status);
      }
      return response;
    } catch (error) {
      throw mapFetchError(
        error,
        isAborted(options.signal),
        timeoutController.signal.aborted,
      );
    } finally {
      clearTimeout(timeout);
    }
  }
}

function isAborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true;
}

function combineSignals(
  external: AbortSignal | undefined,
  timeout: AbortSignal,
): AbortSignal {
  return external === undefined
    ? timeout
    : AbortSignal.any([external, timeout]);
}

function mapHttpStatus(status: number): GitLabError {
  if (status === 401)
    return new GitLabError("authentication", "GitLab rejected the token.", {
      status,
    });
  if (status === 403)
    return new GitLabError("authorization", "GitLab denied this operation.", {
      status,
    });
  if (status === 409)
    return new GitLabError("conflict", "GitLab reported a conflicting ref.", {
      status,
    });
  if (status === 404)
    return new GitLabError("notFound", "GitLab resource not found.", {
      status,
    });
  if (status === 429)
    return new GitLabError("rateLimited", "GitLab rate limit reached.", {
      status,
    });
  if (status >= 500)
    return new GitLabError("server", "GitLab server error.", { status });
  return new GitLabError("invalidResponse", `GitLab returned HTTP ${status}.`, {
    status,
  });
}

function mapFetchError(
  error: unknown,
  externallyAborted: boolean,
  timedOut: boolean,
): GitLabError {
  if (error instanceof GitLabError) return error;
  if (externallyAborted)
    return new GitLabError("cancelled", "Request cancelled.", { cause: error });
  if (timedOut)
    return new GitLabError("timeout", "Request timed out.", { cause: error });

  const cause = error instanceof Error ? error.cause : undefined;
  const code =
    isRecord(cause) && typeof cause.code === "string" ? cause.code : "";
  if (
    [
      "CERT_HAS_EXPIRED",
      "DEPTH_ZERO_SELF_SIGNED_CERT",
      "SELF_SIGNED_CERT_IN_CHAIN",
      "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
    ].includes(code)
  ) {
    return new GitLabError("tls", "TLS certificate validation failed.", {
      cause: error,
    });
  }
  return new GitLabError("network", "Network request failed.", {
    cause: error,
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
