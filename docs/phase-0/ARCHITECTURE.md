# Architecture

## Product boundary

The extension has two deliberately separate modes:

1. **Remote browsing:** query GitLab and expose immutable, read-only file
   content without creating a local Git repository.
2. **Local materialization:** invoke native Git to create an explicitly owned
   checkout under a configured root, then let VS Code and its built-in Git SCM
   provide normal editing and source-control workflows.

Remote cleanup operations are not part of the product. Releasing a workspace
can only remove a validated local checkout.

## Extension-host placement

The extension should use `extensionKind: ["workspace"]` so operations execute
where the workspace extension host runs.

- In native Windows, settings, secrets, paths, Git, credential helper, cache,
  registry, and filesystem checks are Windows-native.
- In Remote–WSL, those facilities are WSL/Linux-native.
- Windows and WSL do not discover, share, or delete one another's managed
  checkouts.
- A WSL clone root should default to the Linux filesystem, not `/mnt/c`, for
  performance and filesystem-semantic reliability.

Settings that differ by environment, especially the clone root, must support
VS Code remote-scoped configuration. No code may translate a Windows path into
a WSL path or the reverse for workspace management.

## Logical components

```text
Extension activation/composition root
├── Instance service
│   ├── settings validation
│   └── SecretStorage token lookup
├── GitLab client
│   ├── authenticated REST transport
│   ├── pagination/retry/rate-limit policy
│   └── typed groups/projects/refs/tree/files API
├── Remote catalog tree provider
├── Project/ref context service
├── reposhelffs read-only FileSystemProvider
├── Memory caches
│   ├── catalog/tree metadata
│   └── bounded immutable file bytes
├── Materialization service
│   ├── managed-path allocator
│   ├── native Git process runner
│   └── ownership marker/registry writer
├── Workspace safety service
├── Disk-usage service
└── Output/logging and user-notification adapters
```

Domain logic must depend on interfaces rather than directly on VS Code APIs,
`fetch`, process spawning, or the filesystem. This keeps safety and API logic
unit-testable without an Extension Development Host.

## Remote browsing workflow

1. Read a validated instance definition and retrieve its PAT from
   `SecretStorage`.
2. Lazily request direct groups, subgroups, and projects with complete
   pagination.
3. Select a project ref, initially its default branch.
4. Resolve the display ref to a full commit SHA.
5. Browse the tree against the selected navigation context.
6. When opening a file, create a URI pinned to the resolved full SHA.
7. The provider retrieves bytes for that exact commit/path and exposes them as
   read-only.
8. Changing branch refreshes the tree but never mutates an already-open
   immutable document.

The provider rejects write, rename, delete, and create operations with
`NoPermissions` or the closest API-appropriate filesystem error.

## Materialization workflow

1. Capture instance, project, selected ref, resolved commit, and selected path.
2. Resolve an editable target branch. Tags and commits require creation or
   selection of a branch. Effective protected-branch permissions must be
   respected.
3. Validate and canonicalize the configured clone root.
4. Allocate a unique destination scoped by instance ID, project ID, and branch
   identity. Do not derive safety from human-readable names.
5. Clone to a uniquely named temporary sibling using HTTPS and native Git.
6. For partial/sparse mode, use `--filter=blob:none --sparse`, then configure
   cone-mode directory paths. Editing a file selects its containing directory.
7. Validate repository identity, remote URL, checked-out branch/commit, and
   filesystem containment.
8. Write the ownership marker under the private Git directory and the host-local
   registry entry only after the checkout is healthy; atomically rename the
   temporary directory into place.
9. Open the checkout in a new VS Code window and reveal the selected local
   file/folder.

Failures must terminate child processes, report a redacted actionable error,
and remove only a proven extension-created temporary directory.

## Cross-window handoff

The browsing and materialized windows cannot rely on shared memory. The
materialization service persists non-secret host-local metadata before invoking
`vscode.openFolder` with `forceNewWindow: true`. The new extension host
discovers the marker and registry record, validates both, and reconstructs the
workspace context.

Closing a window is never permission to release a checkout.

## Network policy

- API requests may send a PAT only to the exact validated configured GitLab
  origin, including its expected HTTPS scheme, host, port, and optional base
  path.
- Redirects must not forward authorization across origins. Unexpected
  cross-origin redirects fail closed.
- Git operations receive an HTTPS repository URL without embedded credentials.
- The Git credential helper is responsible for Git authentication.
- Proxy and CA behavior should first follow supported VS Code/Node and Git host
  configuration. Custom certificate bypass (`rejectUnauthorized: false`) is
  prohibited.

## Error and cancellation policy

Long-running API, Git, filesystem scan, and disk-size operations must expose
cancellation. Cancellation is a normal outcome, not an error notification.
Errors shown to users include a stable category and remediation but no token,
credential response, sensitive header, or unredacted command environment.
