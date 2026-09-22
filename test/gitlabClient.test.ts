import { describe, expect, it, vi } from "vitest";
import {
  RestGitLabClient,
  getNextLink,
} from "../src/infrastructure/gitlabClient.js";
import type {
  GitLabHttpClient,
  HttpResponse,
} from "../src/infrastructure/http.js";

describe("RestGitLabClient", () => {
  it("parses the current authenticated user", async () => {
    const http = createHttpMock([
      response({
        id: 42,
        username: "ada",
        name: "Ada Lovelace",
        web_url: "https://gitlab.example.test/ada",
      }),
    ]);
    const client = new RestGitLabClient(http.client);
    await expect(client.getCurrentUser()).resolves.toEqual({
      id: 42,
      username: "ada",
      name: "Ada Lovelace",
      webUrl: "https://gitlab.example.test/ada",
    });
  });

  it("follows Link pagination and requests only top-level groups", async () => {
    const nextUrl = "https://gitlab.example.test/api/v4/groups?page=2";
    const first = response([group(1, "Alpha")], {
      link: `<${nextUrl}>; rel="next"`,
    });
    const second = response([group(2, "Beta")]);
    const http = createHttpMock([first], [second]);
    const client = new RestGitLabClient(http.client);

    const groups = await client.listTopLevelGroups();

    expect(groups.map(({ name }) => name)).toEqual(["Alpha", "Beta"]);
    expect(http.get).toHaveBeenCalledWith(
      "groups",
      expect.objectContaining({ per_page: "100", top_level_only: "true" }),
      undefined,
    );
    expect(http.getAbsolute).toHaveBeenCalledWith(new URL(nextUrl), undefined);
  });

  it("requests only direct group projects", async () => {
    const http = createHttpMock([response([])]);
    const client = new RestGitLabClient(http.client);
    await client.listGroupProjects(123);
    expect(http.get).toHaveBeenCalledWith(
      "groups/123/projects",
      expect.objectContaining({
        include_subgroups: "false",
        with_shared: "false",
      }),
      undefined,
    );
  });

  it("searches accessible projects with a bounded server-side request", async () => {
    const nextUrl = "https://gitlab.example.test/api/v4/projects?page=2";
    const http = createHttpMock([
      response([project(842, "Catalog", "platform/catalog")], {
        link: `<${nextUrl}>; rel="next"`,
      }),
    ]);
    const client = new RestGitLabClient(http.client);
    const controller = new AbortController();

    await expect(
      client.searchProjects("  platform  ", controller.signal),
    ).resolves.toEqual([
      {
        id: 842,
        name: "Catalog",
        pathWithNamespace: "platform/catalog",
        namespaceId: 24,
        namespaceKind: "group",
        defaultBranch: "main",
        webUrl: "https://gitlab.example.test/platform/catalog",
        httpUrlToRepo: "https://gitlab.example.test/platform/catalog.git",
      },
    ]);
    expect(http.get).toHaveBeenCalledWith(
      "projects",
      {
        search: "platform",
        search_namespaces: "true",
        min_access_level: "10",
        simple: "true",
        order_by: "name",
        sort: "asc",
        per_page: "100",
      },
      controller.signal,
    );
    expect(http.getAbsolute).not.toHaveBeenCalled();
  });

  it("rejects a malformed project search response", async () => {
    const http = createHttpMock([response({ projects: [] })]);
    const client = new RestGitLabClient(http.client);
    await expect(client.searchProjects("catalog")).rejects.toMatchObject({
      code: "invalidResponse",
    });
  });

  it("rejects malformed collection responses", async () => {
    const http = createHttpMock([response({ not: "an array" })]);
    const client = new RestGitLabClient(http.client);
    await expect(client.listTopLevelGroups()).rejects.toMatchObject({
      code: "invalidResponse",
    });
  });

  it("searches branches and resolves a slash-containing branch", async () => {
    const sha = "a".repeat(40);
    const http = createHttpMock([
      response([branch("feature/upgrade", sha)]),
      response(branch("feature/upgrade", sha)),
    ]);
    const client = new RestGitLabClient(http.client);

    await expect(client.searchBranches(842, "upgrade")).resolves.toEqual([
      {
        name: "feature/upgrade",
        commitSha: sha,
        isDefault: false,
        isProtected: false,
        canPush: true,
      },
    ]);
    await client.resolveBranch(842, "feature/upgrade");

    expect(http.get).toHaveBeenNthCalledWith(
      1,
      "projects/842/repository/branches",
      expect.objectContaining({ search: "upgrade", per_page: "100" }),
      undefined,
    );
    expect(http.get).toHaveBeenNthCalledWith(
      2,
      "projects/842/repository/branches/feature%2Fupgrade",
      {},
      undefined,
    );
  });

  it("loads one repository path at an immutable commit", async () => {
    const sha = "b".repeat(40);
    const http = createHttpMock([
      response([
        {
          id: "tree-id",
          name: "src",
          path: "packages/src",
          type: "tree",
          mode: "040000",
        },
      ]),
    ]);
    const client = new RestGitLabClient(http.client);

    await expect(
      client.listRepositoryTree(42, sha, "packages"),
    ).resolves.toEqual([
      {
        id: "tree-id",
        name: "src",
        path: "packages/src",
        type: "tree",
        mode: "040000",
      },
    ]);
    expect(http.get).toHaveBeenCalledWith(
      "projects/42/repository/tree",
      expect.objectContaining({ ref: sha, path: "packages" }),
      undefined,
    );
  });

  it("retrieves raw file bytes with an encoded repository path", async () => {
    const sha = "c".repeat(40);
    const bytes = new Uint8Array([1, 2, 3]);
    const http = createHttpMock([binaryResponse(bytes)]);
    const client = new RestGitLabClient(http.client);

    await expect(
      client.getRawFile(42, sha, "docs/my file.md"),
    ).resolves.toEqual(bytes);
    expect(http.get).toHaveBeenCalledWith(
      "projects/42/repository/files/docs%2Fmy%20file.md/raw",
      { ref: sha },
      undefined,
    );
  });

  it("rejects a raw file above the hard safety limit before reading its body", async () => {
    const sha = "d".repeat(40);
    const response = binaryResponse(new Uint8Array([1]), {
      "content-length": "52428801",
    });
    const bytes = vi.spyOn(response, "bytes");
    const http = createHttpMock([response]);
    const client = new RestGitLabClient(http.client);

    await expect(client.getRawFile(42, sha, "large.bin")).rejects.toThrow(
      "50 MiB safety limit",
    );
    expect(bytes).not.toHaveBeenCalled();
  });

  it("rejects an abbreviated branch commit SHA", async () => {
    const http = createHttpMock([response(branch("main", "abc1234"))]);
    const client = new RestGitLabClient(http.client);
    await expect(client.resolveBranch(42, "main")).rejects.toMatchObject({
      code: "invalidResponse",
    });
  });
});

describe("getNextLink", () => {
  it("returns undefined without a next relation", () => {
    expect(
      getNextLink(
        new Headers({
          link: '<https://gitlab.example.test/api/v4/groups?page=1>; rel="prev"',
        }),
      ),
    ).toBeUndefined();
  });
});

function createHttpMock(
  getResponses: HttpResponse[],
  absoluteResponses: HttpResponse[] = [],
): {
  client: GitLabHttpClient;
  get: ReturnType<typeof vi.fn>;
  getAbsolute: ReturnType<typeof vi.fn>;
} {
  const get = vi.fn().mockImplementation(() => {
    const value = getResponses.shift();
    return value === undefined
      ? Promise.reject(new Error("Unexpected get call"))
      : Promise.resolve(value);
  });
  const getAbsolute = vi.fn().mockImplementation(() => {
    const value = absoluteResponses.shift();
    return value === undefined
      ? Promise.reject(new Error("Unexpected getAbsolute call"))
      : Promise.resolve(value);
  });
  return {
    client: { get, getAbsolute } as unknown as GitLabHttpClient,
    get,
    getAbsolute,
  };
}

function response(value: unknown, headers: HeadersInit = {}): HttpResponse {
  const body = JSON.stringify(value);
  return {
    status: 200,
    headers: new Headers(headers),
    json: () => Promise.resolve(JSON.parse(body) as unknown),
    text: () => Promise.resolve(body),
    bytes: () => Promise.resolve(new TextEncoder().encode(body)),
  };
}

function binaryResponse(
  bytes: Uint8Array,
  headers: HeadersInit = {},
): HttpResponse {
  return {
    status: 200,
    headers: new Headers({
      "content-type": "application/octet-stream",
      ...headers,
    }),
    json: () => Promise.reject(new Error("Binary response is not JSON")),
    text: () => Promise.resolve(new TextDecoder().decode(bytes)),
    bytes: () => Promise.resolve(bytes),
  };
}

function branch(name: string, commitSha: string): unknown {
  return {
    name,
    commit: { id: commitSha },
    default: name === "main",
    protected: name === "main",
    can_push: true,
  };
}

function group(id: number, name: string): unknown {
  return {
    id,
    name,
    full_name: name,
    full_path: name.toLowerCase(),
    parent_id: null,
    web_url: `https://gitlab.example.test/groups/${name.toLowerCase()}`,
  };
}

function project(id: number, name: string, pathWithNamespace: string): unknown {
  return {
    id,
    name,
    path_with_namespace: pathWithNamespace,
    namespace: { id: 24, kind: "group" },
    default_branch: "main",
    web_url: `https://gitlab.example.test/${pathWithNamespace}`,
    http_url_to_repo: `https://gitlab.example.test/${pathWithNamespace}.git`,
  };
}
