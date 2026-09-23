import { spawn } from "node:child_process";
import { GitLabError } from "../domain/errors.js";

const MAX_OUTPUT_BYTES = 2 * 1024 * 1024;

export interface GitRunOptions {
  readonly cwd?: string;
  readonly signal?: AbortSignal;
  readonly stdin?: string;
  readonly timeoutMs?: number;
}

export interface GitResult {
  readonly stdout: string;
  readonly stderr: string;
}

export interface GitRunner {
  run(args: readonly string[], options?: GitRunOptions): Promise<GitResult>;
}

export class NativeGitRunner implements GitRunner {
  public constructor(private readonly executable = "git") {}

  public run(
    args: readonly string[],
    options: GitRunOptions = {},
  ): Promise<GitResult> {
    if (isTruthy(process.env.GIT_SSL_NO_VERIFY)) {
      return Promise.reject(
        new GitLabError(
          "configuration",
          "RepoShelf refuses native Git operations while GIT_SSL_NO_VERIFY disables TLS certificate verification.",
        ),
      );
    }
    if (options.signal?.aborted === true) {
      return Promise.reject(
        new GitLabError("cancelled", "Git operation cancelled."),
      );
    }
    return new Promise((resolve, reject) => {
      const child = spawn(this.executable, [...args], {
        cwd: options.cwd,
        shell: false,
        windowsHide: true,
        env: {
          ...process.env,
          GCM_INTERACTIVE: "Never",
          GIT_CONFIG_NOSYSTEM: "0",
          GIT_PAGER: "cat",
          GIT_TERMINAL_PROMPT: "0",
        },
        stdio: ["pipe", "pipe", "pipe"],
      });
      let stdout: Buffer<ArrayBufferLike> = Buffer.alloc(0);
      let stderr: Buffer<ArrayBufferLike> = Buffer.alloc(0);
      let outputExceededLimit = false;
      let settled = false;
      let terminationError: Error | undefined;
      let killTimer: NodeJS.Timeout | undefined;

      const finish = (error?: Error): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        if (killTimer !== undefined) clearTimeout(killTimer);
        options.signal?.removeEventListener("abort", abort);
        if (error !== undefined) reject(error);
        else
          resolve({
            stdout: stdout.toString("utf8").trim(),
            stderr: stderr.toString("utf8").trim(),
          });
      };
      const terminate = (error: Error): void => {
        if (terminationError !== undefined) return;
        terminationError = error;
        if (child.exitCode === null && child.signalCode === null) {
          child.kill("SIGTERM");
        }
        killTimer = setTimeout(() => {
          if (child.exitCode === null && child.signalCode === null) {
            child.kill("SIGKILL");
          }
        }, 2000);
        killTimer.unref();
      };
      const abort = (): void => {
        terminate(new GitLabError("cancelled", "Git operation cancelled."));
      };
      const timeout = setTimeout(
        () => {
          terminate(new GitLabError("timeout", "Git operation timed out."));
        },
        options.timeoutMs ?? 10 * 60 * 1000,
      );

      options.signal?.addEventListener("abort", abort, { once: true });

      child.stdout.on("data", (chunk: Buffer) => {
        const appended = appendBounded(stdout, chunk);
        stdout = appended.output;
        outputExceededLimit ||= appended.exceeded;
      });
      child.stderr.on("data", (chunk: Buffer) => {
        const appended = appendBounded(stderr, chunk);
        stderr = appended.output;
        outputExceededLimit ||= appended.exceeded;
      });
      child.on("error", (error) => {
        finish(
          new GitLabError("configuration", "Unable to start native Git.", {
            cause: error,
          }),
        );
      });
      child.on("close", (code, signal) => {
        if (settled) return;
        if (terminationError !== undefined) finish(terminationError);
        else if (outputExceededLimit) {
          finish(
            new GitLabError(
              "server",
              "Git output exceeded the RepoShelf safety limit.",
            ),
          );
        } else if (code === 0) finish();
        else
          finish(
            new GitLabError(
              "server",
              `Git exited with code ${code ?? "unknown"}${signal === null ? "" : ` (${signal})`}: ${stderr.toString("utf8").trim() || "No error output."}`,
            ),
          );
      });
      if (options.stdin !== undefined) child.stdin.end(options.stdin);
      else child.stdin.end();
    });
  }
}

function isTruthy(value: string | undefined): boolean {
  return value !== undefined && /^(?:1|true|yes|on)$/iu.test(value.trim());
}

function appendBounded(
  existing: Buffer<ArrayBufferLike>,
  chunk: Buffer<ArrayBufferLike>,
): { readonly output: Buffer<ArrayBufferLike>; readonly exceeded: boolean } {
  const remaining = MAX_OUTPUT_BYTES - existing.byteLength;
  return {
    output:
      remaining <= 0
        ? existing
        : Buffer.concat([existing, chunk.subarray(0, remaining)]),
    exceeded: chunk.byteLength > remaining,
  };
}
