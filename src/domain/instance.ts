import { GitLabError } from "./errors.js";
import type { GitLabInstance } from "./models.js";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

export function parseInstances(value: unknown): readonly GitLabInstance[] {
  if (!Array.isArray(value)) {
    throw new GitLabError(
      "configuration",
      "GitLab instance settings must be an array.",
    );
  }

  const instances = value.map(parseInstance);
  const ids = new Set(instances.map((instance) => instance.instanceId));
  if (ids.size !== instances.length) {
    throw new GitLabError(
      "configuration",
      "GitLab instance IDs must be unique.",
    );
  }
  return instances;
}

export function normalizeBaseUrl(
  input: string,
  allowLoopbackHttp = false,
): string {
  const trimmed = input.trim();
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch (error) {
    throw new GitLabError(
      "configuration",
      "Enter a valid absolute GitLab URL.",
      { cause: error },
    );
  }

  const isLoopback =
    url.hostname === "localhost" ||
    url.hostname === "127.0.0.1" ||
    url.hostname === "[::1]";
  if (
    url.protocol !== "https:" &&
    !(allowLoopbackHttp && isLoopback && url.protocol === "http:")
  ) {
    throw new GitLabError(
      "configuration",
      "GitLab instance URLs must use HTTPS.",
    );
  }
  if (url.username !== "" || url.password !== "") {
    throw new GitLabError(
      "configuration",
      "GitLab instance URLs must not contain credentials.",
    );
  }
  if (url.search !== "" || url.hash !== "") {
    throw new GitLabError(
      "configuration",
      "GitLab instance URLs must not contain a query or fragment.",
    );
  }

  url.pathname = url.pathname.replace(/\/+$/u, "");
  return url.toString().replace(/\/$/u, "");
}

function parseInstance(value: unknown): GitLabInstance {
  if (!isRecord(value)) {
    throw new GitLabError(
      "configuration",
      "Each GitLab instance must be an object.",
    );
  }
  if (
    value.schemaVersion !== 1 ||
    typeof value.instanceId !== "string" ||
    !UUID_PATTERN.test(value.instanceId)
  ) {
    throw new GitLabError(
      "configuration",
      "A GitLab instance has an invalid schema version or instance ID.",
    );
  }
  if (typeof value.label !== "string" || value.label.trim() === "") {
    throw new GitLabError(
      "configuration",
      "Each GitLab instance requires a label.",
    );
  }
  if (typeof value.baseUrl !== "string" || typeof value.enabled !== "boolean") {
    throw new GitLabError(
      "configuration",
      "A GitLab instance has invalid URL or enabled fields.",
    );
  }

  return {
    schemaVersion: 1,
    instanceId: value.instanceId.toLowerCase(),
    label: value.label.trim(),
    baseUrl: normalizeBaseUrl(value.baseUrl),
    enabled: value.enabled,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
