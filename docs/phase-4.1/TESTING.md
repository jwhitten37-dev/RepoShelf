# Phase 4.1 Test Plan

Each subphase has a separate gate. A later subphase must not begin while its gate
has a known failure. Destructive scenarios use only disposable repositories and
clone roots.

## Phase 4.1A — architecture gate

Phase 4.1A changes contracts, not runtime behavior. Run from the repository root:

```bash
npm run format:check
npm run lint
npm run typecheck
npm test
npm run build
npm audit --audit-level=high
git diff --check
```

Also validate all repository-relative Markdown links and review the protocol and
threat table against these questions:

- Can any lease, closure, push, age, reminder, request, or journal record grant a
  deletion capability? The answer must be no.
- Can two hosts both claim one operation? The answer must be no.
- Can an expired claim be stolen? The answer must be no.
- Does claimant failure retain the checkout and require a newly authorized
  operation? The answer must be yes.
- Are unsaved-buffer visibility limits stated accurately? The answer must be yes.
- Are registry concurrency, ignored content, clock changes, upgrades, redaction,
  bounded parsing, and fallback arbitration specified? The answer must be yes.

Passing 4.1A means the unchanged Phase 4 automated suite passes and reviewers
approve these contracts. It does not demonstrate coordinator runtime behavior.

## Phase 4.1B — protocol implementation gate

Add automated unit and component tests before enabling coordination by default.
Tests must use temporary directories and injected clocks/UUIDs where possible.

### Record and parser tests

- Round-trip every schema and reject unknown versions/properties, invalid UUIDs,
  noncanonical SHA values, invalid times, oversized/deep records, and path/record
  identity mismatch.
- Verify immutable create-once publication, temporary-file interruption, duplicate
  publication, malformed claim directory, and no-follow journal-root checks.
- Verify diagnostics redact credentials, sensitive URL parts, raw ignored paths,
  and record bodies.

### State-machine and authorization tests

- Cover every valid transition and reject skipped, reversed, duplicate,
  conflicting, expired, replayed, and cross-workspace transitions.
- Prove request, detachment, lease, claim, completion, push success, and timeout
  cannot directly call deletion.
- Prove capability minting requires all bound distributed evidence and every fresh
  Phase 4 check, and remains in-memory, short-lived, and single-use.
- Verify cancellation before/after claim and all crash cut points retain data
  unless absence has been verified.

### Concurrency and recovery tests

- Spawn independent Node workers against one temporary journal; race two
  coordinators and the fallback at least hundreds of times and assert exactly one
  claim per operation.
- Race independent workspaces and prove no shared state, blocking, cancellation,
  registry removal, or outcome crosses workspace IDs.
- Kill a worker before claim publication, after claim, before deletion, during
  simulated deletion, after absence proof, and during registry/catalog updates.
- Verify claims are never stolen, crashed operations require a new operation, and
  reconciliation removes registry state only after proven absence.
- Simulate sleep, backward/forward clock changes, lease sequence regression,
  request expiry, mixed extension versions, unknown schemas, and a pending legacy
  Phase 4 intent.

### VS Code integration tests

In an Extension Development Host with disposable data:

1. Open a catalog window, materialize a workspace, and identify both session IDs.
2. Run Release and Push and Release; verify the managed folder closes, the
   coordinator alone claims, deletion is freshly validated, and the catalog
   window remains.
3. Close the coordinator before release; verify the restarted empty host wins the
   unclaimed request and completes the existing safe flow.
4. Crash the coordinator after claim; verify fallback does not steal and the UI
   requires a freshly confirmed retry.
5. Close the managed window without Release, reopen through Edit Locally, and
   verify tracked, untracked, ignored, committed, and unsaved state is preserved.
6. Repeat with two workspaces and confirm their sessions, requests, claims,
   outcomes, and registry records remain isolated.

Record operation IDs, state transitions, sanitized output, filesystem existence,
marker/registry state, local `HEAD`, and remote ref SHA. Never record credentials
or repository content.

## Phase 4.1C — UX gate

Automated tests must verify command registration, menus, context keys, status-bar
state, dashboard projection, targeted refresh, reminder scheduling, snooze, and
per-workspace isolation. They must prove every visible release action invokes the
same authorization service rather than a weaker deletion path.

Manual Extension Development Host checks must cover:

- SCM title and overflow actions in clean, dirty, pushing, blocked, and detached
  states;
- accessible labels, keyboard operation, progress/cancellation, and actionable
  redacted errors;
- retained-workspace Reopen behavior and explicit choice when more than one
  retained workspace matches;
- generated versus unclassified ignored content, with `.env`, key, database, and
  local-note fixtures blocked by default;
- reminder threshold, Keep Open, Remind Me Later, Review and Release, and Close
  Window while keeping the local copy; and
- refresh failure shown separately after successful local release.

Use fake timers for automated reminder tests. Advance far beyond every threshold
and assert no push, release, filesystem removal, or registry removal occurs.

## Phase 4.1D — native Windows adversarial gate

Follow the executable
[native Windows adversarial runbook](./WINDOWS-ADVERSARIAL-GATE.md). The
**Windows native gate** workflow supplies the candidate VSIX and automated
native-runner evidence; it does not replace the interactive matrix.

Build and install the candidate VSIX on native Windows. Use a dedicated temporary
clone root and disposable GitLab project/branches. For every scenario in the
[Phase 4.1 plan](./README.md#phase-41d-native-windows-adversarial-gate):

1. capture initial marker, registry, `HEAD`, remote ref, ignored inventory, and
   filesystem state;
2. perform the exact window/crash/network/clock/process interference;
3. run the release or recovery action;
4. verify either complete safe release or retained local data with recovery
   evidence; and
5. rerun after VS Code restart to verify durable reconciliation.

For successful release, assert the exact checkout is absent, its registry entry
is absent, unrelated workspaces still exist, and the remote branch and expected
commit remain. For blocked/failed release, assert the checkout, marker, local
state, ignored fixtures, and registry evidence remain. Inspect logs for secrets
and raw sensitive ignored filenames.

Attach a sanitized matrix containing VS Code/extension/Windows/Git versions,
filesystem type, operation result, expected/actual state, and evidence location.
Phase 4.1 is not production-ready until every matrix row passes.
