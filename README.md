# RepoShelf

![RepoShelf — Remote-first repository workspaces for VS Code](docs/images/reposhelf-banner.png)

**Remote-first repository workspaces for VS Code.**

RepoShelf lets you browse repositories without cloning every project, then
materialize a controlled partial/sparse or full local workspace only when normal
editing and Git tooling are needed. GitLab is the first implemented provider;
the product identity and architecture remain provider-neutral.

> [!IMPORTANT]
> RepoShelf is pre-release software. Phase 4 implementation and native Windows
> happy-path validation are complete. The remaining adversarial gate and planned
> Phase 4.1 coordinated-release/production-UX hardening are required before
> production use. Closing a window never authorizes workspace deletion.

## Current capabilities

- Connect to multiple GitLab instances, each with an independently stored PAT in
  VS Code `SecretStorage`.
- Browse groups, projects, branches, and repository trees lazily.
- Open immutable, read-only remote files pinned to a full commit SHA.
- Compare a pinned file with the same path on another branch.
- Materialize full or partial+sparse Git workspaces through native Git.
- Validate clone roots, origins, branches, commits, sparse scope, and private
  ownership markers before creating or reusing a managed workspace.
- Run a read-only, fail-closed managed-workspace safety assessment covering
  ownership, containment, dirty/unsaved state, Git operations, remote
  reachability, and local-only refs.
- Push committed work to an explicit managed branch, verify the remote result,
  and release only the proven local checkout after explicit confirmation.
- Keep remote file content in a bounded memory-only cache.

See [PHASED-PLAN.md](./PHASED-PLAN.md) for scope and sequencing. Design and
security contracts are under [docs/phase-0](./docs/phase-0/README.md), with
implementation records for [Phase 1](./docs/phase-1/README.md),
[Phase 2](./docs/phase-2/README.md), [Phase 3](./docs/phase-3/README.md),
[Phase 4](./docs/phase-4/README.md), and planned
[Phase 4.1](./docs/phase-4.1/README.md).

Corporate CA and proxy setup has separate extension-host and native-Git paths.
See the [Phase 6 corporate network gate](./docs/phase-6/CORPORATE-NETWORK-GATE.md)
before organizational use; RepoShelf never requires disabling TLS verification.

## Safety and privacy

- RepoShelf does not collect telemetry.
- API PATs are stored in VS Code SecretStorage and are never inserted into Git
  URLs or process arguments.
- Native Git authentication is delegated to the host's HTTPS credential helper.
- Remote source bodies are not persistently cached by RepoShelf.
- Managed workspace release is fail-closed and never deletes remote data. Native
  Windows junction/reparse and open-handle validation remains mandatory before a
  production release.

Never include credentials, private repository content, internal URLs, project
identifiers, usernames, or ownership-marker data in public issues or logs. See
[SECURITY.md](./SECURITY.md) for private vulnerability reporting.

## Development

Requirements:

- VS Code 1.137.0 or newer
- Node.js 24 (the exact development pin is in `mise.toml`)
- npm
- Git for materialization tests

```bash
git clone https://github.com/jwhitten37-dev/RepoShelf.git
cd RepoShelf
npm ci
npm run check
npm run build
```

If you use [mise](https://mise.jdx.dev/), run commands through `mise exec --` to
use the pinned Node.js version.

Marketplace packaging and the Microsoft Entra workload-identity release process
are documented in [docs/PUBLISHING.md](./docs/PUBLISHING.md).

To exercise the extension UI, open the checkout in VS Code, select
**Run RepoShelf Extension** in Run and Debug, and press `F5`. Use only an
authorized test instance and least-privilege credentials.

## Rename compatibility

RepoShelf is a clean-break rename of the pre-release GitLab On-Demand prototype.
Old command IDs, settings, SecretStorage entries, remote URI schemes, extension
state, default workspace roots, and ownership markers are not migrated. Existing
prototype workspaces are not deleted; they must be inspected and managed
manually.

## Contributing and support

Read [CONTRIBUTING.md](./CONTRIBUTING.md) before opening a pull request. Use
[GitHub Discussions](https://github.com/jwhitten37-dev/RepoShelf/discussions)
for usage questions when available and GitHub Issues for reproducible bugs and
approved feature proposals. The project is currently maintained on a
best-effort basis; see [SUPPORT.md](./SUPPORT.md).

## License and trademarks

RepoShelf is licensed under the [Apache License 2.0](./LICENSE).

RepoShelf is an independent project and is not affiliated with, endorsed by, or
sponsored by GitLab Inc., GitHub, Inc., or Microsoft Corporation. GitLab,
GitHub, Visual Studio Code, and related marks belong to their respective owners.
