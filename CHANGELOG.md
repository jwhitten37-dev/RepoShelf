# Changelog

All notable changes to RepoShelf will be documented in this file. The format is
based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and releases
will follow [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

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

- Added publication ignores and a pre-publication sensitive-value audit.
- Added guarded ownership/path validation, exact remote-result verification,
  immediate pre-delete revalidation, no-follow removal, and fail-closed partial
  failure handling.

## [0.1.0] - Unreleased

- Phase 1 GitLab connection and remote catalog.
- Phase 2 branch-aware, immutable remote repository browsing.
- Phase 3 guarded full and partial+sparse local materialization.
