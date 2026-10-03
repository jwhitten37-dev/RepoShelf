import { GitLabError } from "./errors.js";

export type RepositoryOriginComparison =
  | { readonly kind: "match" }
  | {
      readonly kind: "mismatch";
      readonly reason: "host" | "path";
      readonly repositoryHost: string;
      readonly instanceHost: string;
    };

/**
 * Checks that a GitLab-reported clone URL belongs to the configured instance:
 * same HTTPS host and port, under the instance's base path. Git authenticates
 * to whatever host it clones from, so a clone URL elsewhere would use the
 * credentials the helper holds for that other host.
 */
export function compareRepositoryOrigin(
  repositoryUrl: string,
  instanceBaseUrl: string,
): RepositoryOriginComparison {
  const repository = parseHttpsUrl(repositoryUrl, "repository clone URL");
  const instance = parseHttpsUrl(instanceBaseUrl, "GitLab instance URL");

  // URL.host is lowercase and omits the default port, so `:443` and an
  // implicit port compare equal while any other port does not.
  if (repository.host !== instance.host) {
    return mismatch("host", repository, instance);
  }
  const basePath = instance.pathname.replace(/\/+$/u, "");
  if (basePath !== "" && !repository.pathname.startsWith(`${basePath}/`)) {
    return mismatch("path", repository, instance);
  }
  return { kind: "match" };
}

function mismatch(
  reason: "host" | "path",
  repository: URL,
  instance: URL,
): RepositoryOriginComparison {
  return {
    kind: "mismatch",
    reason,
    repositoryHost: repository.host,
    instanceHost: instance.host,
  };
}

function parseHttpsUrl(value: string, description: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch (error) {
    throw new GitLabError("configuration", `The ${description} is invalid.`, {
      cause: error,
    });
  }
  if (url.protocol !== "https:") {
    throw new GitLabError(
      "configuration",
      `The ${description} must use HTTPS.`,
    );
  }
  return url;
}
