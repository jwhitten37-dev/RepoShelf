# Phase 4.1: Coordinated Release and Workspace UX

## Status

**Phase 4.1B complete; Phase 4.1C implementation in progress.** Phase 4
established a safe restart-based Windows release path. Phase 4.1 retains that
path as a fallback while adding cross-window coordination, retained-workspace
lifecycle UX, visible release actions, reminders, and recovery behavior suitable
for production use. Genuine Windows sleep/resume remains part of the Phase 4.1D
native-Windows matrix.

The 4.1B storage substrate implements strict bounded record parsing, no-follow
journal setup, immutable publication, atomic lease replacement, ordered
identity-bound transitions, cancellation, and non-stealable claims.

The 4.1B reconciliation substrate now also implements bounded operation-state
projection, duplicate active-operation detection, one-time legacy registry
import, filesystem-authoritative per-workspace snapshots, workspace/path-scoped
non-stealable mutation locks, exact-record removal after injected fresh absence
proof, and one-way `globalState` mirror repair. The filesystem registry is now the
active authority for materialization, safety checks, legacy release, coordinated
release, recovery, and mirror repair.

The 4.1B session slice now creates coordinator, managed, and detached host
sessions; publishes privacy-preserving environment fingerprints and monotonic
leases; detects sleep and clock anomalies; binds managed windows through bounded
immutable materialization handoffs; and publishes detachment evidence only after
consuming a schema-v2 restart intent. Exact coordinator-versus-fallback claim
arbitration and independent-process crash/race tests are implemented. Phase
4.1B-4 connects the sole claimant to deletion only through complete distributed
evidence validation, fresh Phase 4 checks, a short-lived in-memory capability,
and immediate pre-removal revalidation. Recovery never steals a claim or deletes;
it reconciles metadata only after fresh filesystem absence proof. Legacy schema-v1
restart intents retain the Phase 4 path. Extension Development Host Gates 1–7
and simulated suspend/resume validation are complete. The coordination audit
trail is retained in `coordination-v1`.

This phase must begin with an architecture and threat-model review. A lock,
lease, heartbeat, journal entry, successful push, elapsed time, or window closure
is coordination evidence only and never deletion authority.

## Non-negotiable invariants

1. Closing a coordinator or managed-workspace window never authorizes release.
2. A successful push never independently authorizes deletion.
3. Workspace age, inactivity, lease expiry, or a stopped heartbeat may trigger
   assessment or notification but never unattended deletion.
4. Every operation is bound to one workspace ID, canonical path, clone root,
   instance, project, repository URL, target branch, expected HEAD, operation ID,
   request nonce, coordinator session, and managed-window session.
5. Dirty, staged, untracked, unsaved, locally committed, local-ref-only,
   ignored-but-unclassified, linked, moved, replaced, unreachable, or otherwise
   ambiguous state blocks deletion.
6. Ignored by Git does not mean disposable.
7. A release request or coordination journal cannot invoke deletion. A claimant
   must rerun all fresh safety checks and mint its own short-lived, in-memory,
   single-use deletion capability.
8. Ambiguous, malformed, stale, duplicated, or conflicting operation state fails
   closed and retains the checkout and registry record.
9. Registry removal occurs only after verified filesystem absence.
10. No force-delete or ignore-safety action is introduced.

## Phase 4.1A: Architecture and threat model

The implementation contracts are:

- [Coordination protocol](./COORDINATION-PROTOCOL.md)
- [Threat and recovery review](./THREAT-MODEL.md)
- [Subphase test plan](./TESTING.md)

Phase 4.1B cannot begin until these contracts complete review and the 4.1A gate
passes. In particular, claims are atomic and non-stealable: claimant failure
retains the checkout and requires a newly confirmed operation rather than unsafe
stale-lock takeover.

Define and review before coordinator implementation:

- A host-local, workspace-scoped operation journal under extension-controlled
  global storage. VS Code `globalState` remains the registry but is not treated
  as a real-time cross-window message bus.
- Immutable or version-checked atomic operation records for materialization,
  managed sessions, release requests, claims, cancellation, completion, and
  failure.
- Random coordinator and managed-window session IDs with expiring leases.
- Exclusive, atomic claim semantics so exactly one eligible extension host can
  process a release request.
- Lease expiry and crash recovery. An expired lease permits investigation and may
  allow a still-unclaimed operation's fallback claimant to race for its one atomic
  claim; an existing claim is never stolen. Neither case permits deletion.
- Explicit user authorization boundaries, request expiration, replay prevention,
  schema versioning, duplicate suppression, and clock/sleep handling.
- Registry concurrency and completion reconciliation.
- The existing restart-safe empty-host flow as the fallback when the original
  coordinator is absent, closes, crashes, or cannot claim promptly.
- Redacted diagnostics and bounded retention/cleanup of completed or abandoned
  coordination records.

The preferred lifecycle is:

```text
catalog coordinator (window 1) materializes workspace
→ managed window (window 2) edits, confirms, pushes, and verifies
→ window 2 writes a short-lived release request and closes
→ window 1 atomically claims the request
→ window 1 proves window 2 is detached and reruns all fresh safety checks
→ window 1 mints a new deletion capability, removes, verifies, and unregisters
→ window 1 refreshes the affected project/branch and remains the active catalog
```

If no coordinator is available, the current restart-safe host may claim and
complete the same request after fresh validation.

## Phase 4.1B: Coordinated lifecycle

### Coordinator closes while a managed workspace remains open

- The managed workspace remains usable, registered, and present on disk.
- No release request or cleanup timer is inferred from coordinator loss.
- Push and Release may use another atomic claimant or the restart-safe fallback.
- The managed window clearly reports that its original coordinator is
  unavailable when that affects the next action.

### Managed window closes without Release

- The checkout and registry record remain unchanged whether the workspace is
  clean or contains local work.
- No release request is created and no timer starts.
- The coordinator shows **Local workspace closed — checkout retained**.
- Selecting **Edit Locally** again finds the registry record, revalidates marker,
  path, Git identity, origin, branch, and clone mode, then reopens the exact
  checkout with its saved, staged, untracked, ignored, committed, branch, and tag
  state intact.
- Failed ownership or identity validation blocks reuse; RepoShelf never
  overwrites, deletes, or clones over the path.

### Push verifies but managed-window closure fails

- The coordinator does not delete while the managed session is still attached.
- The short-lived request expires or is cancelled, while the pushed commit and
  registry metadata remain available for reconciliation.
- The UI reports **Push verified; release blocked because the workspace is still
  open. Local checkout retained.**
- A later Release reruns fresh checks and does not needlessly push again when
  exact remote equality is re-proven.

### Multiple managed workspaces

- Journals, leases, requests, claims, reminders, statuses, and completions are
  scoped by workspace ID rather than global singleton state.
- No active-window or current-project assumption supplies destructive identity.
- A claim or completion for one workspace is structurally unusable for another.
- Concurrent releases serialize only per workspace, not globally.

### External processes and handles

Package installs, builds, test watchers, development servers, shells, Docker bind
mounts, language tooling, and other processes may create ignored files or retain
handles. Detectable Git/filesystem changes block release. Persistent handles
cause bounded fail-closed removal failure with registry retention; RepoShelf does
not attempt to kill unrelated processes or force deletion.

### Completion and catalog reconciliation

After verified local deletion and registry removal, the coordinator must:

- invalidate affected project/ref caches;
- refresh the project and branch metadata from the provider;
- retain or reselect the released branch;
- update local-workspace status to remote-only; and
- display the newly pushed commit when applicable.

Catalog refresh failure does not change successful deletion into a deletion
failure. It produces a separate **Local release succeeded; remote catalog refresh
failed** state with a retry action.

## Phase 4.1C: Production UX

### Visible lifecycle actions

Keep Command Palette commands for accessibility and keyboard use, and add
context-aware actions for validated managed workspaces:

- Source Control view: **Check Workspace Safety**, **Push and Release**, and
  **Release Local Workspace**.
- Status bar: a RepoShelf lifecycle action or quick pick.
- RepoShelf managed-workspace dashboard: project, branch, path, clone mode, disk
  usage, lifecycle status, blockers, open/reopen, release, and diagnostics.

Context keys control visibility but never replace fresh command-time safety
checks. RepoShelf must not create a duplicate SCM provider merely to expose these
actions.

### Post-release window behavior

- Prefer completion in the original catalog coordinator, leaving no redundant
  empty window in the normal flow.
- Retain restart-safe completion when no coordinator is available.
- If fallback leaves an empty host, offer **Close Window** and **Browse Remote**;
  automatic closure is allowed only after successful release and when unrelated
  unsaved or untitled content cannot be lost.

The 4.1C completion presenter now distinguishes verified local release from
provider refresh and registry-reconciliation results. Normal coordinator
completion remains in the catalog window. A detached fallback host offers
**Browse Remote** and offers **Close Window** only when no folder, dirty document,
or untitled document could be lost. Provider refresh resolves the released branch
before reporting success. Failure is reported as **Local release succeeded;
remote catalog refresh failed** with an explicit retry; retry never repeats local
deletion.

### Workspace-age reminders

Workspace age or observed inactivity may trigger a workspace-specific reminder,
never a push, release, or deletion. Initial actions are:

- **Review and Release** — perform a read-only fresh assessment, show blockers and
  ignored-content summary, then use the normal explicit confirmation workflow.
- **Close Window, Keep Local Copy** — close the editor while retaining checkout
  and registry metadata.
- **Keep Open** — dismiss for the current workspace/session.
- **Remind Me Later** — snooze only this workspace.

Suggested settings cover enablement, reminder age, and snooze interval. There is
no silent timed-release setting in Phase 4.1. Activity evidence is advisory and
incomplete, so its only effect is reminder timing.

The initial 4.1C reminder slice uses the later of persisted `lastOpenedAt` and
the current managed-host session start as advisory activity evidence. It stores
bounded snoozes per workspace ID and suppresses **Keep Open** for the current
extension-host session. Timer callbacks can request a notification only; they
cannot invoke Git, release, filesystem removal, or registry mutation. **Review
and Release** routes to the normal release command and its fresh assessment and
explicit confirmation, while **Close Window, Keep Local Copy** changes no
RepoShelf registry or coordination state.

### Ignored content policy

Before release, distinguish tracked state, untracked non-ignored content, known
generated ignored content, and unclassified ignored content. Broad `.gitignore`
rules may hide `.env` files, databases, keys, notes, fixtures, or other valuable
local data.

- Dirty, staged, and untracked non-ignored content blocks release.
- Unclassified ignored content blocks pending review.
- Known generated content such as `node_modules`, build output, or caches may be
  presented separately and accepted only through a reviewed policy and explicit
  confirmation.
- Repository policy cannot name paths outside the checkout, bypass no-follow
  checks, or silently classify unknown content as disposable.

The initial reviewed generated-path policy classifies ignored leaf entries only
when they are beneath an exact conventional dependency, cache, coverage, virtual
environment, or build-output directory name. It includes `node_modules`, package
manager caches, common compiler/tool caches, `coverage`, `dist`, `build`, and
`out`. A similarly named file, a generated-looking extension, and every path not
matched by this fixed extension policy remain unclassified. Git's ignore engine
enumerates each ignored leaf with NUL delimiters; directory collapsing is not
used. Only category counts leave the collector. Malformed, truncated, oversized,
or over-count inventories fail closed, and raw ignored filenames are not logged
or displayed by RepoShelf.

The Local Workspaces dashboard measures each retained checkout without following
links, limits measurement concurrency, and cancels stale refresh generations.
Disk usage is presentation evidence only: unavailable measurement is displayed
separately and never authorizes release or weakens fresh command-time checks.

## Phase 4.1D: Native Windows adversarial gate

Using only disposable data, validate:

- original coordinator closes first;
- managed window closes clean or dirty without Release;
- existing retained workspace is reopened with all local state preserved;
- push succeeds but handoff writing or managed-window closure fails;
- coordinator crashes before and after atomic claim;
- coordinator disappears and restart-safe fallback succeeds;
- duplicate coordinators and duplicate/replayed requests;
- multiple simultaneous managed workspaces and releases;
- `node_modules` or known generated ignored content;
- unclassified ignored `.env`, database, key, and local-note fixtures;
- long-open clean and dirty workspaces, reminder, snooze, and no silent deletion;
- active shell, package install, build watcher, dev server, and open file handle;
- network failure during coordinator revalidation;
- sleep, backward/forward clock changes, request expiry, and extension upgrade;
- moved/replaced checkout and junction/reparse paths; and
- successful deletion followed by catalog-refresh failure and retry.

Every failure must retain local data and registry recovery evidence unless
deletion completed and absence was verified.

## Phase 5 integration: sparse expansion

Phase 5 owns safe scope expansion. When an existing sparse workspace is selected
for local editing, RepoShelf offers:

- **Reopen Workspace** — revalidate and reopen the retained checkout.
- **Expand Workspace** — add directories or convert sparse checkout to a full
  worktree while preserving edits, commits, ignored content, and identity.
- **Release and Rematerialize as Full Clone** — only after complete release
  safety, verified absence, and registry removal.
- **Cancel**.

Expansion is preferred over deletion/reclone. Closing the sparse workspace does
not free its allocation or make immediate full-clone materialization safe.

## Exit criteria

- The coordinator protocol and fallback are threat-modeled and tested.
- Window closure, push success, leases, reminders, and age cannot independently
  authorize deletion.
- Retained workspaces reopen safely and multiple workspaces remain isolated.
- Visible Source Control/status/dashboard actions invoke unchanged fresh safety
  checks.
- Normal coordinated release returns the user to the original refreshed catalog
  without a redundant window.
- Reminder and ignored-content behavior cannot silently lose local work.
- The complete native Windows adversarial matrix passes.
