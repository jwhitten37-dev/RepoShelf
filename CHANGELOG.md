# Changelog

All notable changes to RepoShelf will be documented in this file. The format is
based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and releases
will follow [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

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

## [0.1.0] - Unreleased

- Phase 1 GitLab connection and remote catalog.
- Phase 2 branch-aware, immutable remote repository browsing.
- Phase 3 guarded full and partial+sparse local materialization.
