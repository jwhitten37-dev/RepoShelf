# RepoShelf Privacy and Data Handling

Last reviewed: 2026-09-23

RepoShelf is a local VS Code extension. It does not include a telemetry SDK, serve
advertising, or send usage analytics to the RepoShelf maintainer. It communicates
with GitLab instances configured by the user and invokes native Git for explicitly
requested local workspace operations.

## Data sent over the network

### GitLab API

RepoShelf sends HTTPS requests to the exact origin and optional base path of each
configured GitLab instance. Requests may include:

- the instance's PAT in the `PRIVATE-TOKEN` header;
- project, group, branch, commit, tree, and file identifiers;
- project and branch search text entered by the user;
- a requested remote branch name and exact source commit SHA when the user confirms
  branch creation.

The PAT is constrained to the configured GitLab API origin and path. Cross-origin
or out-of-path redirects are rejected. Remote branch creation is dispatched once
and is never automatically retried.

GitLab's processing, retention, and audit logging are governed by the operator of
the configured instance, not by RepoShelf.

### Native Git

Clone, fetch, push, and remote verification are performed by the native Git
executable in the extension host environment. RepoShelf supplies the HTTPS
repository URL without embedded credentials and delegates authentication to the
configured Git credential helper. Git and any configured proxy communicate with
the selected GitLab server according to host configuration.

### Marketplace and source hosting

VS Code and the Visual Studio Marketplace may process extension installation and
update data under Microsoft's policies. Opening documentation, support, or source
links contacts GitHub under GitHub's policies. RepoShelf does not receive those
platform records directly.

## Data stored locally

### VS Code settings

For each configured GitLab instance, RepoShelf stores a generated instance ID,
display label, HTTPS base URL, and enabled state in VS Code configuration. Other
RepoShelf settings include the managed clone root and bounded timeout, retry,
memory-cache, disk-advisory, and reminder preferences.

### SecretStorage

One GitLab API PAT per instance ID is stored through VS Code `SecretStorage`.
RepoShelf does not store PATs in settings, Git URLs, command arguments, workspace
markers, registry records, or telemetry. The operating system and VS Code control
the underlying secret-storage implementation.

### Extension global storage

RepoShelf persists bounded coordination, reminder, pending-operation, and managed
workspace registry records in VS Code extension global storage. These records may
include generated operation/workspace IDs, local workspace paths, GitLab instance
and project identity, repository URL, selected branch, exact commit SHA, sparse
scope, timestamps, status, and safety metadata. They do not contain PATs or remote
file bodies.

These records support cross-window coordination, workspace ownership checks,
recovery, and fail-closed deletion. They are not uploaded by RepoShelf.

### Managed workspaces

After explicit materialization, Git source and metadata are stored under the
configured clone root, which defaults to `~/reposhelf-workspaces`. RepoShelf adds a
private ownership marker used to bind the checkout to its registry record. A
managed checkout remains on disk when its VS Code window closes.

### Remote file cache

Remote source bodies are cached only in bounded process memory. RepoShelf does not
persist an offline source-content cache. The memory cache is cleared when the
extension host ends and can also be cleared through RepoShelf's refresh behavior.

### Logs

The RepoShelf output channel contains bounded operational diagnostics. PAT/token
formats, authorization and proxy-authorization values, sensitive object fields,
and URL userinfo pass through redaction. Logs can still contain nonsensitive but
private context such as an instance label, project ID, branch, commit SHA, or local
managed path when needed to explain an operation. Review and sanitize output before
sharing it.

## User controls and deletion

- Removing a GitLab instance removes its configuration and SecretStorage PAT after
  confirmation. Managed workspace records and local checkouts are retained so that
  instance removal cannot silently destroy source or local work.
- Remote catalog and file caches can be cleared without deleting local workspaces.
- A managed workspace is removed only after explicit user action, confirmation,
  and fresh ownership, path, Git-state, reachability, and remote-result checks.
- RepoShelf release removes only the proven local checkout and its registry record.
  It does not delete a remote project, commit, or branch.
- Uninstalling the extension does not intentionally delete managed workspaces.
  VS Code and the operating system govern retention/removal of extension settings,
  SecretStorage, and global-storage data. Review retained workspaces before manually
  removing RepoShelf storage.

## Corporate proxies and certificate authorities

RepoShelf relies on approved host mechanisms for Node.js extension-host API calls
and native Git. Proxy URLs or host environment variables may contain credentials;
RepoShelf does not manage or persist them. Do not place proxy credentials or
certificate contents in issue reports or diagnostic evidence. RepoShelf refuses
known environment switches that disable TLS verification.

## No telemetry

RepoShelf does not collect product analytics, usage events, crash telemetry, or
unique tracking identifiers. No telemetry endpoint or telemetry SDK is included.
Future telemetry would require an explicit policy and documentation change; it is
not enabled by user settings today.

## Public reports and privacy questions

Never submit real PATs, credentials, cookies, private source, internal URLs,
organization/project names, project IDs, usernames, absolute personnel paths,
proxy details, certificate contents, or ownership-marker data to a public issue.

Use [GitHub private vulnerability reporting](https://github.com/jwhitten37-dev/RepoShelf/security/advisories/new)
for suspected security issues. Use the sanitized support channels in
[SUPPORT.md](../SUPPORT.md) for other questions.
