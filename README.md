# RepoShelf

![RepoShelf — Remote-first repository workspaces for VS Code](docs/images/reposhelf-banner.png)

**Remote-first repository workspaces for VS Code.**

RepoShelf lets you browse GitLab repositories without cloning every project, then
materialize a guarded partial/sparse or full local workspace only when normal
editing and Git tooling are needed.

> [!IMPORTANT]
> RepoShelf is pre-release software. Use authorized repositories and review your
> organization's GitLab, credential, proxy, certificate, and source-handling
> policies before use. Closing a VS Code window never authorizes workspace
> deletion.

## Features

- Connect to multiple GitLab instances with an independently stored personal
  access token (PAT) for each instance.
- Browse groups, personal projects, branches, and repository trees lazily.
- Search accessible projects within a selected GitLab instance.
- Open immutable, read-only remote files pinned to a full commit SHA.
- Compare a pinned file with the same path on another branch.
- Create a remote branch from an exact source commit after collision checks and
  explicit confirmation; remote writes are never retried automatically.
- Materialize full or partial clone plus cone-mode sparse-checkout workspaces
  through native Git.
- Reopen retained workspaces and review their disk usage from the Local Workspaces
  dashboard.
- Assess ownership, containment, dirty and unsaved state, Git operations, remote
  reachability, ignored content, and local-only refs before release.
- Push committed work to an explicit managed branch, verify the remote result, and
  remove only the proven local checkout after explicit confirmation.

RepoShelf never force-updates or deletes a remote branch.

## Requirements

- VS Code 1.137.0 or newer.
- Native Git available in the extension host environment for local materialization,
  fetch, push, and release verification.
- An HTTPS GitLab instance reachable from the extension host.
- A least-privilege GitLab PAT approved by your GitLab administrator. Required
  permissions depend on the repositories and operations your administrator allows.
- A configured Git HTTPS credential helper when using local workspace operations.
  RepoShelf does not reuse the API PAT as a Git password.

When using Remote–WSL, RepoShelf's API and Git operations execute in WSL. Configure
the WSL trust store, proxy environment, Git installation, and credential helper
independently from Windows.

## Getting started

1. Install the RepoShelf pre-release from the Visual Studio Marketplace, or install
   a reviewed VSIX supplied by your administrator.
2. Open the **RepoShelf** icon in the Activity Bar.
3. Select **Add GitLab Instance**.
4. Enter the GitLab HTTPS base URL, including any required relative URL prefix.
5. Enter a display label and your approved PAT. RepoShelf tests the connection
   before saving the instance.
6. Expand the instance to browse groups and projects, or use its inline search
   action.
7. Select a project branch to browse remote files. Use **Edit Locally** only when a
   native Git workspace is needed.

The default managed-workspace root is `~/reposhelf-workspaces`. Configure
`reposhelf.cloneRoot` before the first materialization to use another location.

## Managed workspace lifecycle

Materialized repositories are extension-managed workspaces, not temporary folders.
Closing their VS Code window retains the checkout. RepoShelf records ownership and
identity metadata so it can revalidate the exact path, project, remote, branch,
commit, and sparse scope before reuse or release.

Use the **Local Workspaces** dashboard to reopen, inspect, or assess a workspace.
Release is fail-closed: dirty files, unsaved editors, unknown ignored content,
ongoing Git operations, local-only refs, changed identity, unsafe paths, or
unverified remote state block deletion. Time and disk thresholds are advisory and
never trigger automatic push or removal.

Removing a GitLab instance deletes that instance configuration and stored PAT but
retains its managed local workspaces for explicit review.

## Corporate CA and proxy configuration

The GitLab API and native Git are separate network paths and may require separate
configuration. RepoShelf relies on approved VS Code extension-host, Node.js,
operating-system, and Git mechanisms. It does not provide a TLS bypass or custom
proxy credential store.

Never set `NODE_TLS_REJECT_UNAUTHORIZED=0`, `GIT_SSL_NO_VERIFY`, or Git
`http.sslVerify=false`. See the
[corporate network gate](./docs/phase-6/CORPORATE-NETWORK-GATE.md) for supported
configuration boundaries and Windows/Remote–WSL guidance.

## Privacy and security

- RepoShelf does not collect telemetry.
- API PATs are stored in VS Code `SecretStorage`, sent only to the exact configured
  GitLab API origin/path, and never inserted into Git URLs or process arguments.
- Native Git authentication is delegated to the host's HTTPS credential helper.
- Remote source bodies use a bounded memory-only cache and are not persistently
  cached by RepoShelf.
- Logs pass through credential and URL-userinfo redaction. Do not publish logs until
  you have independently checked them for private environment details.
- Managed workspace metadata is persisted for ownership and deletion safety; source
  files exist on disk only after explicit materialization.

Read the full [privacy and data-handling disclosure](./docs/PRIVACY.md) and
[security policy](./SECURITY.md). Report suspected vulnerabilities privately; do
not open a public security issue.

## Current limitations

- GitLab is the only implemented provider.
- Authentication uses PATs; OAuth is not implemented.
- Merge-request creation and status integration are not implemented.
- Remote browsing requires network access. RepoShelf has no persistent offline
  source cache.
- Existing sparse workspaces cannot be expanded in place. Materialize a distinct
  workspace when a different scope is required.
- RepoShelf does not protect, unprotect, rename, update, merge, or delete remote
  branches.

## Development

RepoShelf uses Node.js 24, TypeScript, ESLint, Prettier, and Vitest.

```bash
git clone https://github.com/jwhitten37-dev/RepoShelf.git
cd RepoShelf
npm ci
npm run check
npm run build
```

Marketplace packaging and the Microsoft Entra workload-identity release process
are documented in [docs/PUBLISHING.md](./docs/PUBLISHING.md). Contributors should
read [CONTRIBUTING.md](./CONTRIBUTING.md) before opening a pull request.

## Support

Use [GitHub Issues](https://github.com/jwhitten37-dev/RepoShelf/issues) for
sanitized reproducible bugs and scoped feature requests. The project is maintained
on a best-effort basis; see [SUPPORT.md](./SUPPORT.md).

Never include credentials, private source, internal URLs, organization or project
identity, usernames, absolute personnel paths, or ownership-marker contents in
public reports.

## License and trademarks

RepoShelf is licensed under the [Apache License 2.0](./LICENSE).

RepoShelf is an independent project and is not affiliated with, endorsed by, or
sponsored by GitLab Inc., GitHub, Inc., or Microsoft Corporation. GitLab, GitHub,
Visual Studio Code, and related marks belong to their respective owners.
