# Security and Threat Model

## Assets

- GitLab PAT and authenticated API session context.
- Corporate source code and repository metadata.
- User edits, local commits, branches, tags, and build artifacts.
- Local filesystem content outside the managed clone root.
- GitLab remote projects, refs, and history.
- Corporate network, proxy, and CA configuration.

## Trust boundaries

- User-entered settings to extension code.
- Extension code to VS Code `SecretStorage`.
- Extension host to the GitLab HTTPS endpoint.
- Extension host to native Git and its credential helper.
- GitLab-provided names/content to URIs, UI, logs, and filesystem paths.
- Registry/marker metadata to destructive filesystem operations.
- Remote browser window to independently running local workspace window.
- Cross-window operation journals, leases, requests, claims, and completion
  records to independently running extension hosts.

## Principal threats and controls

| Threat                             | Required controls                                                                                             |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| PAT disclosure                     | `SecretStorage`; never URL/argv/log/setting/marker/telemetry; redact headers and error bodies                 |
| Credential sent to attacker origin | Exact origin allowlist; validate base URL; strip auth on redirects; reject unexpected cross-origin redirects  |
| TLS bypass/MITM                    | No insecure TLS option; use approved CA/proxy paths; actionable certificate errors                            |
| Path traversal from GitLab names   | IDs for identity; sanitize display names; reject `..`, separators, roots, reserved names                      |
| Symlink/junction deletion escape   | Canonical containment plus component no-follow checks immediately before deletion                             |
| Deleting an unrelated repository   | Versioned marker + registry agreement + remote identity + Git and path validation + confirmation              |
| Loss of local work                 | Dirty/operation/ref/reachability/unsaved-buffer checks; no force release                                      |
| Command injection                  | Spawn executable with argument array; no shell; validate options; use `--`; controlled environment            |
| Credential prompt deadlock         | Non-interactive Git process policy, timeout/cancellation, credential-helper diagnostics                       |
| Malicious repository content       | Read-only bytes; no automatic execution; VS Code trust model remains in effect for local folders              |
| Sensitive persistent cache         | No persistent file bytes in Phases 1–5; approval required for Phase 6                                         |
| Denial of service                  | Pagination bounds, response/file hard limits, timeouts, cancellation, bounded cache, lazy loading             |
| Log leakage                        | Structured categories, URL/header/token/query redaction, no environment dumps, opt-in diagnostic detail       |
| Stale authorization                | Treat 401/403 distinctly; clear session capability state; revalidate before protected operations              |
| Forged/replayed release handoff    | Versioned workspace-bound immutable records; random IDs/nonces; expiry; atomic single claim; fresh full proof |
| Coordinator/session crash          | Leases permit recovery only; no lease/heartbeat/window state grants deletion; retain registry on ambiguity    |
| Cross-workspace confusion          | Bind every journal/request/claim/capability to exact workspace, path, project, branch, and expected HEAD      |
| Timer-based loss of work           | Age/inactivity triggers reminders only; no silent timed push/release/deletion; explicit confirmation required |
| Ignored local data loss            | Ignored is not disposable; inventory/classify conservatively; unknown ignored content blocks release          |
| External process interference      | Fresh Git/filesystem checks; bounded handle failure; do not kill processes or force deletion                  |
| Unintended remote ref write        | Explicit no-match action and confirmation; exact-SHA source; collision preflight; create-only endpoint        |
| Duplicate/ambiguous remote write   | Send POST once; never replay redirects/retry automatically; exact GET reconciliation; report uncertainty      |

## Token policy

- Store one PAT per `instanceId` in `SecretStorage`.
- Request/document least privileges supported by corporate policy.
- Never reuse the PAT as a Git password automatically.
- Removing an instance removes its secret after confirmation and clears its
  in-memory authenticated cache.
- Token validation reports user identity and capabilities without persisting
  the token or full response.

## Remote content handling

Remote files are untrusted bytes. Opening a remote document must not execute
tasks, activate repository-local extensions as a workspace, run language build
hooks automatically, or render active HTML inside extension-owned webviews.
VS Code may provide language features according to its own trust/security
model; the extension itself performs no content execution.

Materialized repositories open as normal VS Code folders in a new window. The
extension must not bypass Workspace Trust prompts or mark a folder trusted.

## Logging policy

The output channel uses levels/categories and records enough state to explain
failures, especially blocked cleanup. It may include instance label, project ID,
commit SHA, Git exit code, and a user-visible canonical local path where needed.
It must not include:

- PATs, authorization/cookie headers, credentials, or credential-helper output.
- URLs with userinfo or sensitive query values.
- Raw process environment.
- Unbounded API response bodies or source file contents.

All error values pass through one redaction layer before logs or notifications.

## Telemetry and persistence

Telemetry is disabled by default and is not required for local testing. No
telemetry SDK is added without organizational policy approval.

Persistent offline source caching is prohibited unless Phase 6 receives an
approved design for encryption, keys, retention, host isolation, clear-cache,
instance-removal cleanup, and incident response. Without approval, offline mode
is metadata-only or unavailable and clearly communicated.

## Required security review evidence

- Automated redaction tests with realistic token/error variants.
- Path containment tests on Windows and WSL, including adversarial links.
- Destructive tests confined to disposable temporary roots.
- Git argv tests proving no shell or embedded credentials.
- Redirect and origin tests proving authorization cannot cross hosts.
- Manual corporate checks for CA/proxy, PAT policy, credential helper, and
  protected branches before organizational use.
- Phase 6A remote branch creation must satisfy
  [`../phase-6/REMOTE-BRANCH-WRITE-GATE.md`](../phase-6/REMOTE-BRANCH-WRITE-GATE.md)
  before organizational use.
