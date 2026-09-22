export type GitLabErrorCode =
  | "cancelled"
  | "configuration"
  | "authentication"
  | "authorization"
  | "conflict"
  | "notFound"
  | "rateLimited"
  | "tls"
  | "network"
  | "timeout"
  | "server"
  | "writeUncertain"
  | "invalidResponse";

export class GitLabError extends Error {
  public constructor(
    public readonly code: GitLabErrorCode,
    message: string,
    options?: { cause?: unknown; status?: number },
  ) {
    super(message, { cause: options?.cause });
    this.name = "GitLabError";
    this.status = options?.status;
  }

  public readonly status: number | undefined;
}

export function toUserMessage(error: unknown): string {
  if (!(error instanceof GitLabError)) {
    return "An unexpected RepoShelf error occurred. See the output channel for details.";
  }

  const messages: Record<GitLabErrorCode, string> = {
    cancelled: "The GitLab request was cancelled.",
    configuration: error.message,
    authentication:
      "GitLab rejected the token. Verify that it is current and try again.",
    authorization:
      "The token is valid but does not have permission for this operation.",
    conflict: error.message,
    notFound: "The requested GitLab resource was not found.",
    rateLimited: "GitLab rate-limited the request. Wait and try again.",
    tls: "The secure connection to GitLab failed. Check the corporate CA and proxy configuration.",
    network:
      "GitLab could not be reached. Check the URL, network, and proxy configuration.",
    timeout:
      "The GitLab request timed out. Check the network or increase the API timeout setting.",
    server: "GitLab returned a server error. Try again later.",
    writeUncertain:
      "GitLab may have accepted the remote write, but RepoShelf could not confirm the resulting state. Inspect the project before trying again.",
    invalidResponse: "GitLab returned an incompatible or invalid API response.",
  };
  return messages[error.code];
}
