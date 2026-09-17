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

### Changed

- Renamed pre-release commands, settings, URI scheme, storage keys, workspace
  root, and ownership markers from the prototype namespace to `reposhelf`.

### Security

- Added publication ignores and a pre-publication sensitive-value audit.
- Added guarded ownership and path validation before collecting release-safety
  evidence; no push or deletion capability is introduced.

## [0.1.0] - Unreleased

- Phase 1 GitLab connection and remote catalog.
- Phase 2 branch-aware, immutable remote repository browsing.
- Phase 3 guarded full and partial+sparse local materialization.
