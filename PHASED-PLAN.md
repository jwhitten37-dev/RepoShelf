# RepoShelf VS Code Extension: Phased Implementation Plan

> **Phase 0 clarification:** Confirmed decisions and guardrails are maintained
> in [`docs/phase-0/`](./docs/phase-0/). They supersede conflicting provisional
> wording below. Initial development targets a corporate self-managed GitLab,
> runs independently in native Windows and Remote–WSL extension hosts, and is
> tested locally. Public source preservation and branding are tracked separately
> from feature phases. Marketplace packaging, signing, and release remain gated
> until after team-ready hardening. Runtime behavior must not depend on the
> source checkout's Git metadata.

Yes—those refinements are coherent, technically feasible, and make the extension’s purpose much clearer: **remote-first GitLab browsing with short-lived, selectively materialized local edit workspaces**.

The two key rules would be:

1. A remote project and any of its branches are always browsable without a local clone.
2. A local sparse/partial checkout exists only while you actively need normal editing, Git, build, or tooling support—and can be removed after a successful push without touching the remote branch.

GitLab provides an endpoint to list/search a project’s branches and repository APIs to browse files at a specified ref. VS Code extensions can also provide custom, read-only virtual documents or virtual filesystems for remote content.

## Confirmed design decisions

### Branch-aware remote browsing

At the **project** level, the user selects a branch, tag, or commit ref. That selected ref becomes the context for the entire virtual repository tree and every file view.

For example:

```text
platform
└── cluster-bootstrap
    ├── Ref: [ main ▼ ]
    ├── charts
    │   └── bootstrap
    │       └── values.yaml
    └── README.md
```

When you select:

```text
Ref: feature/upgrade-helm
```

The extension should:

- Fetch or resolve that branch from GitLab.
- Refresh the repository tree using that ref.
- Open files at that ref.
- Preserve the selected branch/ref per project as extension metadata.
- Clearly display the active ref in the project node and editor UI.
- Avoid implying that you are viewing `main` when you are really viewing a feature branch.

A remote-file URI should encode enough immutable context to prevent ambiguity:

```text
reposhelffs://gitlab.company.example/
  project/842/
  file/charts/bootstrap/values.yaml
  ?ref=feature%2Fupgrade-helm
```

Even better, after resolving the branch, the extension can capture the commit SHA behind it:

```text
reposhelffs://gitlab.company.example/
  project/842/
  file/charts/bootstrap/values.yaml
  ?ref=feature%2Fupgrade-helm&commit=1a2b3c4d
```

That matters because branches move. A reader who opened a file at 10:00 AM should not silently see different content at 2:00 PM simply because someone pushed new commits. The editor can either:

- Pin the currently opened document to the resolved commit SHA.
- Display an “Updated remotely” notification and offer **Refresh to latest branch head**.
- Explicitly choose a “live branch” mode, with a visible indicator that a refresh may update content.

For the first implementation, pinning open documents to a commit SHA is safest and easiest to reason about.

### Missing-file behavior

If you open:

```text
main → docs/text.md
```

and then change the selected ref to:

```text
feature/restructure-docs
```

The extension should not assume the file exists there. It should:

1. Resolve whether `docs/text.md` exists at the new ref.
2. If yes, reopen or refresh the file from the selected ref.
3. If no, keep the original tab open and show a clear state message such as:

```text
docs/text.md does not exist in feature/restructure-docs.

[Open the file at main]
[Browse feature/restructure-docs]
[Compare refs]
```

If it was renamed, GitLab’s repository API may not give you a guaranteed simple rename mapping for arbitrary branch differences, so “search the selected branch” is generally more dependable than pretending the extension knows the renamed path.

A useful comparison action can be:

```text
Compare:
main ↔ feature/restructure-docs
```

For textual files, that could open VS Code’s native diff editor with the two remote URIs.

### Remove local branch copy, not remote branch

Your correction is important: after commit and push, “cleanup” means:

```text
Remove:
✓ Local checkout/worktree
✓ Locally downloaded sparse paths and Git metadata

Keep:
✓ Remote GitLab project
✓ Remote feature branch
✓ Pushed commit history
✓ Remote branch browsability in the extension
```

The extension can immediately return you to remote browsing of that same branch:

```text
platform / cluster-bootstrap
Ref: feature/upgrade-helm
Status: Remote only
```

You retain full visibility of your newly pushed branch and can reopen its files read-only at any time. If more edits are needed later, the user materializes it again.

## Phased implementation plan

## Phase 0: Design and guardrails

Before coding, define the project’s behavior, data model, and safety boundary.

### Goals

- Initially support the corporate self-managed GitLab while keeping instance
  identifiers and architecture suitable for later multi-instance support.
- Browse remote group/subgroup/project/repository/file hierarchy with no clone.
- Support ref-aware browsing at branch, tag, and immutable commit SHA.
- Materialize local copies only within an explicit managed clone root.
- Never delete remote projects, branches, commits, or GitLab data as part of cleanup.
- Never silently delete local content.

### Non-goals for the first release

- Replace GitLab’s web UI.
- Replace VS Code’s built-in Source Control view.
- Implement a full Git client in TypeScript.
- Transparently make arbitrary remote files editable without a local Git checkout.
- Automatically infer a complete dependency set for application builds.
- Manage merge-request approvals, pipelines, issues, releases, or deployments.

### Core configuration

```json
{
  "reposhelf.instances": [
    {
      "id": "company-gitlab",
      "label": "Company GitLab",
      "baseUrl": "https://gitlab.company.example"
    }
  ],
  "reposhelf.cloneRoot": "C:\\Users\\justin\\source\\gitlab-managed",
  "reposhelf.defaultCloneMode": "partialSparse",
  "reposhelf.remoteDocumentMode": "pinnedCommit",
  "reposhelf.cleanup.confirmAlways": true,
  "reposhelf.cleanup.blockOnUnpushedCommits": true
}
```

### Storage boundary

Use separate stores for separate purposes:

| Data                                                           | Location                     | Reason                             |
| -------------------------------------------------------------- | ---------------------------- | ---------------------------------- |
| PAT or OAuth refresh token                                     | VS Code `SecretStorage`      | Avoid plaintext credential storage |
| Instance URL, clone root, defaults                             | VS Code settings             | User-controlled configuration      |
| Last selected ref, favorites, recent projects, sparse profiles | Extension global storage     | Small local preference metadata    |
| Local clone truth/state                                        | Filesystem plus Git commands | Git and disk are authoritative     |
| Remote project, branch, tree truth                             | GitLab API                   | Server is authoritative            |

### Security requirements

- Validate instance URLs and only send credentials to the configured GitLab host.
- Never include PATs in clone URLs, workspace metadata, logs, error dialogs, telemetry, or copied commands.
- Use `read_api`/`read_repository`-style privileges for browse-only operations where organization policy permits; request broader permissions only for explicit actions that need them.
- Use the OS Git credential helper, SSH agent, or approved enterprise Git authentication workflow for `git clone`, `git fetch`, and `git push`.
- Use the resolved/canonical filesystem path and enforce that all managed local workspaces live below the configured clone root.
- Treat symlinks, Windows junctions, reparse points, and paths outside the clone root as deletion blockers.

### Suggested implementation stack

- TypeScript for the VS Code extension host.
- VS Code Extension API for UI, virtual documents/filesystem, command registration, SecretStorage, storage, output channels, and workspace interaction.
- Native `git` CLI invoked through Node’s process APIs for cloning and local Git validation.
- Direct GitLab REST API requests using `fetch` or a small HTTP client abstraction.
- Vitest or Jest for core unit tests; VS Code extension-host integration tests for user workflows.
- Optional later: a small Go helper only if you find native-Git process orchestration or cross-platform filesystem behavior too awkward in TypeScript. Start with TypeScript only.

## Phase 1: Instance login and remote catalog

**Outcome:** users can connect to GitLab and browse the actual group/subgroup/project structure without creating clones.

### Deliverables

- Command: `RepoShelf: Add GitLab Instance`.
- Prompt for base URL.
- Prompt for PAT, stored in `SecretStorage`.
- Connection test that shows the authenticated user identity and meaningful errors for:
  - Invalid base URL.
  - TLS/certificate failure.
  - Proxy/network failure.
  - Expired/invalid token.
  - Insufficient API scope.
  - GitLab API version incompatibility.
- Command: `RepoShelf: Refresh Catalog`.
- Dedicated Activity Bar container and Explorer tree.

### Tree behavior

```text
RepoShelf
├── Company GitLab
│   ├── Groups
│   │   ├── platform
│   │   │   ├── cluster-bootstrap
│   │   │   └── security
│   │   │       └── kube-audit-policies
│   │   └── applications
│   │       └── billing-api
│   ├── Personal namespace
│   ├── Favorites
│   ├── Recent
│   └── Locally Materialized
```

### API behavior

- Retrieve groups the user can access.
- Retrieve direct projects for expanded groups.
- Retrieve subgroups on demand.
- Do not recursively fetch all groups, projects, branches, and files at activation.
- Cache successful catalog responses with timestamps.
- Add refresh actions at the instance, group, and project levels.
- Gracefully handle pagination from the first implementation; large GitLab organizations cannot rely on default page sizes.

### Acceptance criteria

- A user can configure a self-managed GitLab URL and PAT.
- The extension shows groups and subgroups as actual tree nodes.
- Projects appear as child nodes of their namespace/group, not as flattened full-path strings.
- Expanding a group loads only that group’s direct content.
- No local repository directories are created while browsing.

## Phase 2: Branch-aware remote repository browser

**Outcome:** users can select a branch or other ref and browse its exact remote tree and files without cloning.

### Deliverables

- Project-level ref selector.
- Default branch selected initially.
- Branch search/quick-pick rather than eagerly loading all branches.
- Support for branch refs first; tags and direct commit SHA entry can follow.
- Repository tree beneath a project node.
- Lazy directory expansion.
- Read-only file opening through `reposhelffs:` URIs.
- File-content cache with size limit and eviction.
- Visible project/ref/commit context in tab title, breadcrumb, or editor decoration.

### Ref-selection design

At project level:

```text
cluster-bootstrap
├── Ref: main ▼
├── Browse files
├── Clone options
└── Project actions
```

Selecting a ref should create a project browser context:

```text
projectId: 842
displayRef: feature/upgrade-helm
resolvedCommitSha: 1a2b3c4d...
```

Use **branch name for navigation** but resolve it to a commit SHA before opening a document. The tree can reasonably refresh against the current branch head, while individual documents should default to being pinned to the SHA resolved at open time.

### Missing file flow

If a user switches branches while a document from the prior branch is active:

```text
README.md
Ref being viewed: main
Switch requested: feature/no-readme
```

The extension should:

- Test whether `README.md` exists at the newly selected ref.
- Reopen it at the new ref only if it exists.
- Otherwise retain the old, pinned document and display a non-destructive message.
- Offer **Browse new ref**, **Keep current document**, and **Compare with another ref**.

Never silently change a document’s content because a branch selection changed.

### Acceptance criteria

- A file opened from `main` is visibly identifiable as `main` or, preferably, its resolved SHA.
- Selecting another branch refreshes the project tree to that branch.
- A file absent from the new branch produces a useful state, not a blank editor or generic failure.
- Opening and browsing remote content creates no managed clone.
- Remote documents are read-only.

## Phase 3: Controlled local materialization

**Outcome:** a user can promote a remote file or folder into a normal local Git workspace for editing.

### Deliverables

- Commands:
  - `Edit Locally: This File`
  - `Edit Locally: This Folder`
  - `Clone Project: Partial + Sparse`
  - `Clone Project: Full`
- Clone-mode picker with user defaults.
- Branch/ref-aware clone behavior.
- Configurable managed clone root.
- Native Git execution with cancellation and progress reporting.
- Open the resulting local folder/file in VS Code.
- Persist metadata: project ID, canonical remote URL, branch, clone mode, sparse paths, local path, last opened, local size.

### Recommended clone modes

```text
Browse remotely
Edit this file (partial + sparse)
Edit this folder (partial + sparse)
Custom sparse selection
Full clone
```

For an editable selected file, begin with:

```bash
git clone \
  --filter=blob:none \
  --sparse \
  --branch feature/my-change \
  git@gitlab.company.example:platform/cluster-bootstrap.git \
  C:\Users\developer\source\reposhelf-workspaces\platform\cluster-bootstrap
```

Then configure the sparse paths:

```bash
git -C C:\Users\developer\source\reposhelf-workspaces\platform\cluster-bootstrap \
  sparse-checkout set \
  charts/bootstrap/values.yaml
```

Git’s sparse-checkout feature materializes a selected subset of tracked files into the working tree; it can later switch that subset, add paths, or disable sparsity and repopulate the full tree.

### Important branch/ref behavior

- **Branch selected:** clone/check out that branch directly.
- **Tag selected:** create a new local work branch from the tag, because tags are normally detached and not appropriate as a direct edit target.
- **Commit SHA selected:** require the user to create/select a target branch before editing.
- **Protected branch selected:** offer “create branch from this ref” rather than assuming push permission.
- **Existing local managed checkout for the same project/branch:** reuse it after checking its health and state.
- **Existing checkout for another branch:** either use a separate managed path or, in a later phase, use `git worktree`.

### Acceptance criteria

- Clicking **Edit Locally** from a remote file opens the exact same file from a local path after materialization.
- The selected branch/ref is respected.
- The extension never clones outside the managed clone root.
- A sparse checkout’s selected file/folder becomes editable in standard VS Code.
- Clone failures leave a meaningful error and clean up incomplete temporary directories safely.

## Phase 4: Commit, push, and local release

**Status:** implementation complete; automated WSL validation and native Windows
normal Release and Push-and-Release happy paths pass. The remaining native
Windows adversarial matrix and Phase 4.1 lifecycle hardening remain release
gates.

**Outcome:** users can commit/push their work, then discard only their local working copy while retaining the remote branch for browse-only access.

### Deliverables

- Detect current local Git state:
  - Current branch.
  - Upstream tracking branch.
  - Dirty/staged/untracked state.
  - Ahead/behind state.
  - Ongoing Git operation.
- Use VS Code’s normal Git SCM UI whenever possible for staging, commit, diff, and push.
- Add extension commands:
  - `RepoShelf: Push and Release Local Workspace`
  - `RepoShelf: Release Local Workspace`
  - `RepoShelf: Check Workspace Safety`
- After successful push, return users to remote browsing of the same branch.
- Persist the selected remote branch before release. Record last verification and
  pushed commit metadata while a workspace record remains available.

### “Push and release” sequence

```text
1. Verify there are no unsaved editor buffers.
2. Verify Git repository health.
3. Confirm branch and upstream.
4. Commit through VS Code SCM or confirm there is already a commit.
5. Push branch successfully.
6. Verify local HEAD is no longer ahead of upstream.
7. Close/remove workspace folder from VS Code as needed.
8. Remove the local managed clone directory.
9. Refresh GitLab branch metadata.
10. Reopen remote browsing at:
    project = platform/cluster-bootstrap
    ref = feature/upgrade-helm
```

The remote branch remains intact. The next time the user clicks that branch in the remote explorer, it appears as any other browseable ref. If further changes are needed, the user materializes it again.

### Cleanup rules

Cleanup must be blocked by default if:

- The repository has staged, unstaged, or untracked changes.
- `HEAD` is ahead of its upstream branch.
- There is no tracked upstream branch and fresh intended-remote reachability plus
  no-local-only-ref proof cannot be established.
- A merge, rebase, cherry-pick, revert, or bisect is underway.
- The local path cannot be proven to be under the configured managed root.
- Canonical path resolution indicates a symlink/junction/reparse-point risk.
- VS Code has unsaved documents associated with the workspace.
- The user requested a normal release but the push failed or has not occurred.

The primary removal mechanism can simply delete the entire managed checkout after safety validation. If using Git worktrees later, `git worktree remove` is useful because it refuses to remove a worktree with uncommitted changes unless forced.

### Acceptance criteria

- After a successful push, **Push and Release** removes the local workspace but does not delete or alter the remote branch.
- The project and pushed branch remain visible in the remote explorer.
- A user can open the same branch read-only immediately after release.
- The extension never force-removes a dirty or unpushed workspace.
- Cleanup logs explain precisely why a release action was blocked.

## Phase 4.1: Coordinated release and workspace UX

**Outcome:** the original remote-catalog window coordinates the normal release
lifecycle, retained workspaces reopen safely, and production actions/reminders
improve usability without weakening Phase 4 deletion safeguards.

The authoritative architecture, failure cases, subphases, and native Windows
gate are in [`docs/phase-4.1/README.md`](./docs/phase-4.1/README.md).

### Deliverables

- A workspace-scoped, versioned cross-window operation journal with coordinator
  and managed-session identities, expiring leases, immutable requests, atomic
  claims, completion records, replay prevention, and crash recovery.
- Window 1 as the preferred release coordinator after window 2 explicitly
  confirms, pushes, verifies, hands off, and closes.
- The restart-safe empty-host Phase 4 flow as fallback when the original
  coordinator is unavailable.
- Reopen retained managed workspaces after an ordinary window close; closing a
  window never releases, deletes, or frees its allocation.
- Strict separation among **Close Window, Keep Local Copy**, **Reopen**,
  **Release**, and Phase 5 **Expand** operations.
- Workspace-specific isolation for multiple concurrent managed workspaces.
- Fail-closed handling when push verifies but handoff or window closure fails.
- Conservative ignored-content inventory: ignored does not mean disposable;
  unknown ignored content blocks release pending review.
- Source Control actions, status-bar lifecycle actions, managed-workspace
  dashboard/status, and clear blocked/recovery diagnostics.
- Workspace-age reminders with **Review and Release**, **Close Window, Keep Local
  Copy**, **Keep Open**, and **Remind Me Later**. Timers never silently push,
  release, or delete.
- Post-release project/ref cache invalidation, branch reselection, and catalog
  refresh, with refresh failure reported separately from successful deletion.

### Safety constraints

- Push success, window closure, coordinator loss, stopped heartbeat, lease
  expiry, age, inactivity, and operation files are never deletion authority.
- A coordinator claimant reruns ownership, path, Git, remote, HEAD, ref,
  unsaved-buffer, ignored-content, and registry checks before minting a new
  short-lived deletion capability.
- Duplicate, stale, malformed, conflicting, moved, replaced, linked, or
  incomplete state retains the checkout and registry record.
- External terminals, installs, builds, watchers, servers, and file handles may
  block release but are never killed or bypassed with force deletion.

### Acceptance criteria

- The normal two-window flow ends in the original refreshed catalog without a
  redundant empty window; restart-safe fallback remains available.
- Coordinator/managed-window closure and crash scenarios cannot delete work
  without explicit confirmation and fresh proof.
- Retained clean or dirty workspaces reopen with their local state intact.
- Multiple workspaces and requests cannot cross-authorize one another.
- Reminders and ignored-content handling cannot silently discard local data.
- The Phase 4.1 native Windows adversarial matrix passes using disposable data.

**Status:** complete and signed off. All W01–W28 native-Windows rows passed
against workflow VSIX `chiefwizard.reposhelf@0.1.0` from commit `f263b8d`.
Sanitized sign-off and artifact provenance are retained in
[`docs/phase-4.1/README.md`](./docs/phase-4.1/README.md); environment-sensitive
evidence is not committed.

## Phase 5: Disk management and quality-of-life features

**Outcome:** the extension becomes useful as a VDI disk-pressure tool rather than only a GitLab browser.

### Deliverables

#### Phase 5A — catalog and branch-search quality of life

- Add **Search Projects** to the Remote Catalog title bar. Native Tree Views do
  not embed arbitrary persistent text fields, so the action opens one persistent
  `createQuickPick()` session.
- Search GitLab server-side by project and namespace after a two-character
  threshold and 300 ms debounce. Cancel stale requests and cap each interactive
  query at one 100-item page rather than traversing organization-wide pagination.
- Display busy, no-match, and error states inline without closing the picker.
- On selection, show the complete current result set as a temporary root-level
  Remote Catalog search view. **Clear Project Search** and normal catalog refresh
  return to the hierarchical catalog.
- Replace the branch `showInputBox()` plus `showQuickPick()` sequence with one
  persistent, debounced `createQuickPick()` session. Empty and no-match searches
  remain open; stale requests are cancelled; branch selection retains immutable
  SHA resolution before repository browsing.
- Remote branch creation is not part of Phase 5A. The no-match state identifies
  it as planned for the separately gated Phase 6A remote-write slice.

Phase 5A acceptance requires mocked GitLab query/response tests, cancellation
propagation, bounded-search proof, command/menu registration tests, and manual
Extension Development Host validation of keyboard operation, fast typing,
no-results, errors, selection, clear, and catalog refresh.

#### Phase 5B — local disk dashboard

- Extend the existing **Local Workspaces** view rather than creating a duplicate
  lifecycle dashboard.
- Per-workspace disk usage:
  - Working tree.
  - `.git` directory.
  - Total.
- Sort/filter by size, last opened, branch, clone mode, and project group.
- Aggregate measured usage and a configurable advisory warning threshold. A
  disabled threshold is explicit, and unavailable measurements are never counted
  as zero.
- Inactive workspace recommendations:
  - “Unused for 30 days.”
  - “Uses more than 2 GB.”
  - “Run fresh workspace safety checks before release.”
- Validate ownership, marker, filesystem, and Git structure before measuring.
  Stale, missing, moved, linked, or otherwise unverifiable entries remain in the
  registry and are visibly labeled **Validation required**.
- Measurements do not follow links, support cancellation, and run with bounded
  concurrency. Refresh cancels the previous generation.
- Recommendations based on age or size are presentation only. They never invoke
  push, release, deletion, or registry mutation; “clean and fully pushed” is shown
  only by the existing fresh safety workflow, never inferred from dashboard data.

**Status:** complete and user-tested. Automated tests cover structured
measurement, no-link traversal,
cancellation, aggregate thresholds, unavailable values, sorting, multi-term
filtering, recommendations, settings bounds, and command/menu contributions.

#### Phase 5C — safe sparse expansion and profiles

**Status:** deferred until after the initial Marketplace MVP. Phase 5C is not
complete and is not part of the MVP release scope. The current product may create,
reopen, measure, and safely release supported sparse workspaces, but it does not
promise saved sparse profiles, in-place sparse expansion, profile switching, or
sparse-to-full conversion. Those capabilities retain the safety requirements below
and will be implemented and gated as a post-MVP iteration.

- Saved sparse profiles per project, for example:
  - `helm-only`
  - `ci-config`
  - `service-api`
  - `docs`
- Command to expand sparse checkout paths:
  - `Add folder to local workspace`
  - `Switch sparse profile`
- Revalidate and expand an existing sparse workspace rather than creating a
  conflicting second allocation:
  - `Reopen Workspace`
  - `Expand Workspace` with additional cone-mode directories
  - convert the existing sparse checkout to a full worktree
  - `Release and Rematerialize as Full Clone` only after full release safety
  - `Cancel`
- Preserve edits, commits, ignored content, branch/ref state, marker identity,
  and registry identity during expansion; detect and block checkout conflicts.
- Safe manual cleanup of stale incomplete clone directories.

#### Later Phase 5 quality of life

- Favorites and recent remote projects.
- Additional catalog organization beyond the bounded server-side search delivered
  in Phase 5A.

### Useful dashboard model

```text
Locally Materialized
├── 4.6 GB  applications/billing-api
│           main · Full clone · Last used 22 days ago
│           [Open] [Release local workspace]
├── 142 MB  platform/cluster-bootstrap
│           feature/upgrade-helm · Sparse · Last used today
│           [Open] [Push and release]
└── 36 MB   security/kube-audit-policies
            main · Sparse · Review with fresh safety check
            [Open] [Check workspace safety]
```

The extension should **recommend** cleanup based on state and disk size, but
should not silently delete workspaces based solely on age. Phase 4.1 owns
workspace-age reminders; Phase 5 may surface the same non-destructive status in
the disk dashboard. Phase 5B recommendations require the user to run the normal
fresh safety workflow before any release action.

## Phase 6: Team-ready hardening

**Outcome:** hardened for local validation against the corporate environment and
ready to enter Marketplace MVP release preparation without waiting for deferred
Phase 5C functionality.

### Deliverables

#### Phase 6A — gated authenticated remote branch creation

- Add narrowly scoped authenticated `POST` support only after a dedicated
  remote-write threat-model and test gate passes; existing browse infrastructure
  remains GET-only until then.
- Creation must be an explicit no-match action followed by confirmation. Resolve
  the chosen source ref to an exact commit SHA, recheck target-name collisions
  immediately before `POST /projects/:id/repository/branches`, and never overwrite
  or force-update a branch.
- Treat permissions, protected-branch policy, cancellation, rate limits,
  timeouts, retries, and ambiguous transport failures conservatively. After an
  ambiguous response, query exact branch state and report uncertainty rather
  than repeating a write automatically.
- Validate branch names, redact credentials and sensitive responses, and test
  authorization failures, races, duplicate requests, cancellation, malformed
  responses, and protected/default-branch behavior before enabling the feature.

**Implementation status:** complete; the corporate disposable-project manual gate
remains. The authenticated JSON POST is create-only, exact-origin/path bounded,
sent once, and never replayed across redirects or retried automatically. Exact
preflight collision checks, immutable source-SHA creation, ambiguous-result
reconciliation, explicit confirmation, and conservative conflict/uncertainty
reporting are implemented and covered by automated tests. The authoritative gate
is [`docs/phase-6/REMOTE-BRANCH-WRITE-GATE.md`](./docs/phase-6/REMOTE-BRANCH-WRITE-GATE.md).

#### Later Phase 6 slices

- OAuth authorization-code flow as an alternative to PATs, if GitLab admins approve an OAuth application.
- Multi-instance support, such as corporate GitLab plus GitLab.com. **Complete:**
  existing UUID identities and storage keys remain compatible; enabled instances
  appear as independent catalog roots, search/removal actions are scoped inline to
  an instance row, Command Palette use selects an instance when needed, and removal
  deletes only the selected instance configuration and PAT while retaining managed
  workspaces.
- Corporate CA/proxy support through documented and approved configuration paths.
  **Local implementation complete; manual gate remains:** TLS/proxy diagnostics,
  proxy credential redaction, insecure-environment refusal, separate API/native-Git
  guidance, and the Windows/WSL matrix are in
  [`docs/phase-6/CORPORATE-NETWORK-GATE.md`](./docs/phase-6/CORPORATE-NETWORK-GATE.md).
- Configurable API timeouts, retries, exponential backoff, and rate-limit handling.
  **GET retry slice complete:** transient GET network/timeout/429/5xx failures use
  at most three configurable, cancellation-aware retries with bounded
  `Retry-After` or exponential delays. POST writes remain single-dispatch and are
  never retried automatically.
- Optional offline source behavior only if a persistent-cache security design
  is approved; otherwise retain memory-only source content and document that
  offline source browsing is unavailable.
- Respect GitLab authorization and protected-branch rules.
- Optional merge-request integration:
  - Create MR after push.
  - Open current branch’s MR in a browser.
  - Show basic MR status in project metadata.
- Local Extension Development Host and installation testing; organizational
  publishing and distribution processes are deferred outside this plan.
- Telemetry disabled by default for internal deployments, or explicitly aligned with organizational policy.
- Threat-model review focused on PAT handling, local path deletion, logs, and remote-content rendering.

## Preservation checkpoint: RepoShelf public-source transition

**Status:** transition complete; Phase 4 implementation is complete with native
Windows destructive-path validation retained as a release gate.

- Phase 3 implementation and manual validation are complete.
- Product identity is **RepoShelf**: _Remote-first repository workspaces for VS
  Code._
- The clean-break rename changes commands, settings, URI scheme, storage keys,
  package identity, default workspace root, and private marker paths. Pre-rename
  local state and materializations are not migrated or deleted.
- Public-source preparation includes an Apache-2.0 license, contributor and
  security guidance, automated checks, secret scanning, and GitHub publication.
- Corporate test identifiers and ownership-marker contents are not retained.
- Phase 4 began after this checkpoint with a non-destructive, fail-closed
  workspace safety assessment. Push and deletion remain separate later slices.

## Phase 7: Marketplace release readiness

**Outcome:** a reviewed, reproducible, provider-neutral VS Code Marketplace
release after team-ready hardening.

**MVP scope decision:** Phase 5C sparse profiles and in-place sparse expansion are
explicitly deferred until after the initial Marketplace release. Publication does
not claim those capabilities and does not require their acceptance gate. Phase 6
mandatory hardening and manual gates remain prerequisites; optional OAuth,
merge-request integration, and persistent offline caching are likewise not MVP
release blockers unless separately promoted into scope.

### Deliverables

- Use the confirmed `chiefwizard` Marketplace publisher and extension identity
  `chiefwizard.reposhelf`.
- Finalize provider-neutral icon, listing graphics, screenshots, categories,
  keywords, and accessibility text using the approved RepoShelf palette.
  **Phase 7.2 listing implementation complete:** provider-neutral icon/banner,
  current categories and discoverability metadata, accessible banner text, and
  listing-ready feature/limitation copy are implemented. Screenshots are
  intentionally omitted because no safely sanitized representative dataset is
  available; corporate data must not be captured for listing media.
- Document privacy behavior, telemetry posture, token storage, network access,
  managed-workspace ownership, and deletion safeguards in listing-ready form.
  **Phase 7.2 disclosure implementation complete:** the Marketplace README and
  [`docs/PRIVACY.md`](./docs/PRIVACY.md) describe API/native-Git data flows,
  SecretStorage, settings/global storage, memory-only source caching, managed
  checkout persistence, logs/redaction, user deletion controls, and no telemetry.
- Produce a reproducible VSIX, inspect its complete contents, install it into a
  clean Extension Development Host, and repeat native Windows and Remote–WSL
  release gates.
  **Phase 7.1 packaging implementation complete:** one cross-platform script uses
  the pinned `@vscode/vsce`, enforces exact payload/archive allowlists and the
  `chiefwizard.reposhelf` identity, and emits bounded SHA-256 JSON evidence. Linux,
  Azure, and native-Windows pipelines invoke the same gate. Clean installation and
  environment-specific smoke validation remain manual release gates.
- Define release signing/provenance, changelog, versioning, rollback, and
  publisher-account security procedures.
  **Phase 7.3 governance implementation complete:** the release gate defines
  Marketplace signing boundaries, immutable SHA-256 provenance, semantic version
  and changelog rules, pre-release/stable promotion, rollback/deprecation,
  publisher recovery, and incident response. Publication revalidates downloaded
  evidence immediately before publishing.
- Publish only after security review, dependency audit, license review, and all
  manual gates pass without retaining private environment data.
  **Phase 7.3 license implementation complete:** the locked dependency graph is
  checked against a fail-closed license policy in every standard validation run.
  The development-only `@vscode/vsce-sign*` terms are narrowly reviewed for use
  with Marketplace tooling and those packages remain excluded from the VSIX.

## Build order

If you are implementing this yourself, the highest-value sequence is:

1. GitLab connection and project/group catalog.
2. Branch picker and read-only remote file viewer.
3. Hierarchical virtual repository tree with lazy loading.
4. Partial+sparse local materialization from a remote file/folder.
5. Safe push-and-release local workspace flow.
6. Coordinated cross-window release, retained-workspace UX, visible actions, and
   non-destructive reminders.
7. Disk-management dashboard.
8. Mandatory team-ready hardening and corporate manual gates.
9. Marketplace MVP release readiness.
10. Post-MVP sparse profiles, safe in-place sparse expansion, and sparse-to-full
    conversion.
11. Optional OAuth, merge requests, and other capability-gated enhancements.

That order proves the central value early: **browse any GitLab project and branch without consuming clone space**. It then adds the more complex local Git lifecycle only after the remote viewer, data model, auth, and group/project hierarchy are stable.
