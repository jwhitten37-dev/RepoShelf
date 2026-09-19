# Testing and Phase Gates

## Test strategy

### Unit tests

Run without VS Code or a real GitLab server:

- URL/origin validation and redirect authorization policy.
- Pagination, retries, backoff, cancellation, and error mapping.
- Ref resolution and immutable URI parsing/canonicalization.
- Path/name sanitization and managed-path allocation.
- Cache byte accounting, eviction, and concurrent request deduplication.
- Git output parsing and release-safety decision tables.
- Marker/schema validation and registry reconciliation.
- Secret/log redaction.

### Component tests

Use temporary directories, fake HTTP servers, and real local Git repositories:

- Git process runner, cancellation, timeout, and non-interactive behavior.
- Full and partial/sparse materialization from local test remotes.
- Local branch/upstream/ahead/behind/operation-state fixtures.
- Safe release and deliberately blocked release cases.
- Incomplete clone cleanup confined to disposable roots.
- Mocked GitLab REST contracts including pagination and failures.

### VS Code integration tests

Run in an Extension Development Host:

- Activation and command registration.
- Activity Bar/tree lazy loading and refresh.
- SecretStorage-backed connection flow with mocked transport.
- Read-only `reposhelffs` documents, immutable tabs, and native diff.
- Ref switching and missing-file UX.
- New-window materialization handoff where automation permits.
- Unsaved-document release blocker.

### Platform tests

Release-gated environments are:

- Native Windows using Windows paths, Git, and credential helper.
- VS Code Remote–WSL using Linux paths, Git, and credential helper.

The initial local compatibility baseline is VS Code 1.137.0 on Windows x64,
with its Remote–WSL extension host. VS Code updates are centrally managed and
required. Tests may use newer managed versions, but no newer VS Code API may be
adopted without either preserving the 1.137.0 path or explicitly revising the
documented minimum.

Required adversarial cases include case differences, spaces/Unicode, long
paths, Windows reserved names, symlinks, junctions/reparse points, interrupted
processes, locked files, and cross-device/permission errors. Windows and WSL
must use independent roots and registries.

### Corporate manual validation

Automated tests use mocked HTTP and local Git/GitLab-compatible fixtures. Before
organizational use, manually validate against corporate GitLab:

- Server/API compatibility and pagination.
- PAT scopes, expiration, SSO/SAML behavior, and authorization failures.
- TLS/CA/proxy paths from Windows and WSL.
- HTTPS Git credential-helper clone/fetch/push behavior.
- Protected/default branch behavior and effective permissions.
- API rate-limit response behavior.

Record versions, configuration, test account/namespace, expected results, and
redacted evidence. Automated tests cannot substitute for this gate.

## Global quality gates

Every phase must:

- Type-check, lint, and pass unit/component tests.
- Add tests for new domain logic and failure paths.
- Preserve token/log redaction and cancellation.
- Avoid unbounded API fetches, memory caches, or filesystem scans.
- Provide accessible command labels, keyboard operation, and non-color-only
  status communication.
- Update user/developer documentation for changed contracts.
- Avoid relying on this development folder being a Git repository.

## Phase acceptance gates

### Phase 0 — design and guardrails

- Architecture, URI/data, deletion safety, threat model, and test strategy are
  documented.
- Native Windows and WSL host boundaries are explicit.
- Local-only development/distribution scope is explicit.
- Corporate GitLab and VS Code compatibility inputs are tracked as open.
- No source Git initialization is required or performed.

### Phase 1 — instance login and remote catalog

- One corporate instance can be configured and its PAT stored only in
  `SecretStorage`.
- Connection diagnostics distinguish URL, TLS/proxy, auth, scope, and server
  compatibility errors without leaking credentials.
- Groups/subgroups/projects load lazily with complete pagination and hierarchy.
- Browsing creates no local repository.
- Data/schema/secret keys are already multi-instance-safe.

### Phase 2 — branch-aware remote browser

- Branch selection resolves to a full commit SHA.
- Repository directories load lazily.
- Files open through canonical, immutable, read-only `reposhelffs` URIs.
- Ref switching never silently mutates an open document.
- Missing-file and remote-diff workflows are useful and non-destructive.
- Bounded memory cache behavior is tested.

### Phase 3 — controlled local materialization

- Partial+sparse and full modes work with native Git in Windows and WSL.
- Editing a file materializes its containing cone-mode directory and reveals
  the same file in a new VS Code window.
- Tags/commits/protected branches require a safe editable branch workflow.
- Destination containment, marker creation, and repository identity are proven.
- Failed/cancelled clones leave no unowned destructive cleanup opportunity.

### Phase 4 — commit, push, and release

- Git and unsaved-editor safety state is accurately detected.
- Push and Release verifies the remote result before local deletion.
- Normal release without upstream succeeds only with remote reachability and
  no-local-only-ref proof.
- Dirty, ambiguous, linked, moved, or unsafe paths are blocked with precise
  logs.
- Release never changes/deletes a remote branch and returns to remote browsing.

### Phase 4.1 — coordinated release and workspace UX

Phase 4.1 uses separate architecture, protocol implementation, UX, and native
Windows gates. The exact commands, automated suites, Extension Development Host
scenarios, and evidence requirements are in the
[Phase 4.1 test plan](../phase-4.1/TESTING.md).

- The original catalog window coordinates normal release, while restart-safe
  fallback succeeds when it is absent, without duplicate processing.
- Closing either window, coordinator/session crashes, lease expiry, stopped
  heartbeats, push success, and reminders cannot independently authorize
  deletion.
- Push-verified handoff/closure failure retains the checkout and supports fresh
  release reconciliation.
- Ordinary managed-window closure retains clean or dirty state, and Edit Locally
  revalidates and reopens the exact checkout.
- Multiple workspace journals, claims, reminders, and completions remain isolated
  under concurrency, replay, duplication, and crash recovery.
- Ignored generated content and unknown ignored data are distinguished; unknown
  ignored data blocks release and no process is killed or force-deleted.
- Source Control/status/dashboard actions rerun normal command-time safety checks.
- Age reminders are workspace-specific and notification-only; no silent timed
  deletion exists.
- Successful release refreshes the affected project/branch and distinguishes a
  later catalog-refresh failure from deletion failure.
- The complete disposable native Windows adversarial matrix in the Phase 4.1
  plan passes.

### Phase 5 — disk management and quality of life

- The materialized view reconciles registry, marker, filesystem, and Git state;
  stale entries are labeled, not assumed safe.
- Disk sizes distinguish worktree, Git directory, and total with cancellation
  and bounded concurrency.
- Sorting/filtering/recommendations are accurate and never auto-delete based on
  age or size.
- Sparse-profile expansion is directory-oriented, validates paths, and
  preserves local work.
- Existing sparse workspaces can be reopened, expanded with directories, or
  converted to a full worktree without conflicting allocation or loss of edits,
  commits, ignored content, or identity.
- Release and Rematerialize as Full Clone is offered only after complete release
  proof; closing a sparse workspace alone never frees its allocation.
- Manual stale-temp cleanup uses the same containment/ownership guardrails.

### Phase 6 — team-ready hardening for local validation

- Multiple instances are enabled without breaking prior identifiers/storage.
- Timeout, retry/backoff, rate-limit, proxy, CA, and authorization behavior is
  documented and tested where locally reproducible.
- Telemetry remains disabled unless explicitly approved.
- Persistent offline source cache remains disabled unless its security design
  is approved; the product clearly states the resulting offline capability.
- Threat-model controls and Windows/WSL adversarial safety suites pass.
- Corporate manual validation checklist is complete before organizational use.
- OAuth and merge-request integration are optional capability-gated features,
  not release blockers.
- Organization-wide packaging, marketplace, signing, and distribution process
  work is outside this implementation plan.

## Phase 1 toolchain baseline

The scaffolding gate is cleared with these provisional constraints:

1. Set `engines.vscode` to `^1.137.0` unless manifest semantics or local
   validation demonstrate that an exact lower-bound range is more appropriate.
2. Compile against VS Code 1.137-compatible API typings and do not use proposed
   APIs.
3. Use and pin Node.js 24 LTS for dependency installation, builds, and tests in
   WSL. Do not use the currently installed non-LTS Node.js 25 as the project
   baseline.
4. A Windows-side Node/npm installation is not required; native Windows runtime
   tests execute extension code in VS Code's embedded Node.js 24.18.1 host.
5. Select package manager, TypeScript, test runner, linter, formatter, and
   bundler versions during scaffolding, lock them, and verify that they support
   Node.js 24 and the VS Code 1.137 API baseline.

If an older corporate VS Code release later becomes an organizational support
requirement, lower the engine range only after compatibility tests are added.
