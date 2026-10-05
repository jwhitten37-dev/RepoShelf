# Changelog

All notable changes to RepoShelf will be documented in this file. The format is
based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and releases
will follow [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Changed

- **Release Local Workspace** now uses a sign-out icon instead of a trash can.
  Release removes only the local checkout; the remote project and branch are
  kept.

### Fixed

- Saving or releasing managed workspaces from several VS Code windows at the
  same time no longer reports that workspace registry storage is unavailable.
  Registry records are now added and removed in a single atomic step. This
  resolves the known issue listed for 0.1.1.
- Choosing a project from **Search Projects** now shows only that project in the
  Remote Catalog instead of every search match. **Clear Project Search** returns
  to the full catalog.

## [0.1.1] - 2026-10-02

Security update. All users should upgrade. No data migration is required.

If you defined `reposhelf.instances` or `reposhelf.cloneRoot` in a workspace's
`.vscode/settings.json`, move them to your user settings (or remote settings
under Remote–WSL); workspace values are now ignored. Retained managed
workspaces, stored PATs, and user-level instance settings are unaffected.

Known issue: when two VS Code windows save managed-workspace records at the
same moment, one of them may briefly report that registry storage is
unavailable. The operation fails safely without changing any workspace; retry
it.

### Changed

- Updated the CI artifact upload action used by the native Windows validation
  gate.
- Limited automated dependency updates so type definitions stay aligned with the
  supported Node.js and VS Code versions, and TypeScript stays on a version
  supported by the lint toolchain.
- Updated development tooling: ESLint, Prettier, typescript-eslint, Vitest, and
  Node.js type definitions within the supported major version.

### Security

- GitLab instance definitions and the managed clone root are now read only from
  user or remote-machine settings. Values in a workspace's settings are ignored,
  and RepoShelf shows a one-time notice when a workspace tries to set them.
  Adding or removing an instance no longer copies workspace-provided instances
  into user settings. See advisory
  [GHSA-388m-xcvg-2fj9](https://github.com/jwhitten37-dev/RepoShelf/security/advisories/GHSA-388m-xcvg-2fj9).
- New local checkouts are cloned only from the configured GitLab instance's own
  host and base path. If GitLab reports a clone URL elsewhere, RepoShelf asks for
  explicit confirmation that names the other host before Git contacts it.
  Reopening a retained workspace never clones a replacement checkout.
- RepoShelf now explicitly declares that it requires a trusted workspace.
- Hardened the Marketplace publishing pipeline. Publication installs only a
  pinned, isolated publishing tool with lifecycle scripts disabled, pipeline
  checkouts no longer persist repository credentials, and GitHub Actions are
  pinned to full commit SHAs.

## [0.1.0] - 2026-09-23

### Added

- GitLab connection and a remote project/group catalog.
- Branch-aware, immutable remote repository browsing.
- Guarded full and partial+sparse local materialization.
- Multiple independently authenticated GitLab instance roots with instance-scoped
  search, inline removal, and safe PAT cleanup.
- Debounced project search across each selected GitLab instance.
- Explicit remote branch creation from an exact source commit with confirmation,
  collision protection, single-dispatch POST, and ambiguous-result reconciliation.
- Local Workspaces disk dashboard with sorting, filtering, retained-workspace
  reopening, diagnostics, and non-destructive reminders.
- Configurable, cancellation-aware retries for transient GET network, timeout,
  rate-limit, and server failures; writes remain non-retryable.
- Corporate CA/proxy diagnostics, proxy credential redaction, insecure TLS
  environment refusal, and separate Windows/Remote–WSL guidance.
- Deterministic cross-platform VSIX packaging with exact content allowlists,
  packaged identity validation, and SHA-256 evidence.
- Marketplace-ready privacy/data-handling and current limitations documentation.
- Fail-closed third-party license inventory and release-governance procedures for
  provenance, versioning, stable promotion, rollback, and publisher recovery.
- Public-source repository governance, security policy, and automated checks.
- RepoShelf provider-neutral product identity and package metadata.
- Secretless Azure Pipelines packaging and Marketplace publishing through
  Microsoft Entra workload identity federation.
- Read-only managed-workspace safety assessment with fail-closed ownership,
  containment, Git state, remote reachability, local-only-ref, and unsaved-buffer
  checks.
- Explicit Push and Release and Release Local Workspace commands with post-push
  verification, confirmation, short-lived deletion capabilities, and registry
  recovery behavior.
- Phase 4.1A coordination protocol, threat/recovery review, and explicit
  per-subphase automated, integration, UX, and native Windows test gates.
- Phase 4.1B coordination record validators and a fail-closed filesystem journal
  with immutable publication, bounded reads, session leases, ordered identity
  binding, and atomic non-stealable claims.
- Phase 4.1B bounded operation projection and a filesystem-authoritative workspace
  registry with one-time migration, workspace/path-scoped mutation locks,
  verified-absence-only removal, and one-way global-state mirror reconciliation.
- Phase 4.1B cross-window session descriptors, privacy-preserving environment
  fingerprints, monotonic lease renewal and anomaly handling, immutable
  materialization handoffs, upgrade-safe detachment acknowledgements, and exact
  coordinator/fallback claim arbitration.
- Phase 4.1B distributed release authorization with claimant-only capability
  minting, immediate pre-removal distributed and Phase 4 revalidation, immutable
  cancellation, exact verified-absence registry reconciliation, non-deleting crash
  recovery, terminal outcomes, and coordinator/detached fallback execution.

### Changed

- Deferred sparse profile management and in-place sparse expansion until after the
  Marketplace MVP.
- Kept OAuth, merge-request integration, and persistent offline source caching
  outside the Marketplace MVP scope.
- Renamed pre-release commands, settings, URI scheme, storage keys, workspace
  root, and ownership markers from the prototype namespace to `reposhelf`.
- Added bounded retries for transient Windows directory locks during atomic
  managed-workspace placement.
- Extended bounded native removal retries for transient Windows locks and added
  sanitized filesystem error codes to fail-closed release diagnostics.
- Changed release to close the managed VS Code folder before deletion and resume
  through a one-time expiring intent with full post-restart safety revalidation.
- Made the filesystem workspace registry authoritative for materialization,
  safety, legacy release, coordinated release, recovery, and one-way global-state
  mirror repair; legacy schema-v1 restart intents remain supported.

### Security

- Added exact-origin/API-path credential boundaries, bounded redirect handling,
  proxy/TLS error classification, and deterministic no-retry handling for TLS and
  proxy-authentication failures.
- Added fail-closed refusal of `NODE_TLS_REJECT_UNAUTHORIZED=0` and truthy
  `GIT_SSL_NO_VERIFY` environments.
- Added publication ignores and a pre-publication sensitive-value audit.
- Added guarded ownership/path validation, exact remote-result verification,
  immediate pre-delete revalidation, no-follow removal, and fail-closed partial
  failure handling.
