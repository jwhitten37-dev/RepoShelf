# Phase 4: Commit, Push, and Local Release

## Status

**Implementation complete.** Automated WSL validation and native Windows normal
Release and end-to-end Push-and-Release happy paths pass. The remaining native
Windows adversarial matrix and planned Phase 4.1 lifecycle hardening remain
release gates before production use.

Closing a VS Code window never authorizes deletion.

The current restart-safe empty-host flow is the validated Phase 4 fallback.
[Phase 4.1](../phase-4.1/README.md) plans the production coordinator UX, retained
workspace reopening, visible lifecycle actions, reminders, ignored-content
policy, and complete adversarial gate.

## Implemented workflows

- `RepoShelf: Check Workspace Safety` performs a read-only, fresh remote safety
  assessment.
- `RepoShelf: Release Local Workspace` removes a clean checkout only when local
  HEAD is reachable from the intended freshly fetched remote branch and no local
  ref contains otherwise unreachable commits.
- `RepoShelf: Push and Release Local Workspace` pushes committed work using the
  explicit `HEAD:refs/heads/<managed-target>` refspec, refreshes origin, and
  requires exact local/remote commit equality before release.
- RepoShelf never stages or commits. Dirty state directs the user to VS Code
  Source Control.
- Successful release retains the remote project/branch selection and reuses the
  current window as an empty remote-browsing window.

## Safety sequence

1. Require exactly one folder matching the host-local workspace registry.
2. Reject unsaved text/notebook buffers, dirty Git state, active operations,
   detached/wrong branches, altered origins, shared Git directories, linked
   paths, and incomplete evidence.
3. Fetch all origin branch refs and prove release or push readiness.
4. Measure the checkout without following symbolic links.
5. Display project, branch, canonical path, and disk usage in a modal explicit
   confirmation.
6. For Push and Release, push through native Git/host credential helpers and
   require exact post-push remote SHA equality.
7. Re-run fresh release checks and require the confirmed HEAD.
8. Persist a single-use, two-minute release intent containing only the workspace
   identity and confirmed HEAD. The intent is not deletion authority.
9. Ask VS Code to close the managed folder. Removing the first workspace folder
   restarts the extension host and releases native Windows workspace handles.
10. In the restarted empty host, consume the intent before use, recover the exact
    registry record, re-run fresh remote safety checks, and require the confirmed
    HEAD again.
11. Issue a new single-use, service-owned deletion capability that expires after
    30 seconds. Arbitrary paths and persisted intents cannot invoke deletion.
12. Immediately before removal, revalidate registry, marker, path containment,
    Git identity/state, HEAD, and unsaved buffers without another network gap.
13. Recursively remove only the canonical checkout, verify absence, and only then
    remove the registry record.
14. Preserve the registry record after partial filesystem failure and report a
    fail-closed diagnostic. No force-delete path exists.

Fetch updates local remote-tracking refs but does not alter local branches or the
worktree. Release never deletes or alters remote data. Push and Release performs
only the explicit normal Git branch update requested by the user and never
deletes a remote project or branch.

## Metadata

The host-local registry records `lastVerifiedAt` and, after a successful push,
`lastPushedCommitSha`. These are lifecycle metadata and are not ownership-marker
identity fields. The selected remote branch is persisted before local removal.

## Automated validation

Disposable real-Git tests cover:

- clean and blocked release decisions;
- dirty/unsaved and active-operation detection;
- explicit push and exact post-push remote equality;
- local-only refs and missing remote reachability;
- ownership-marker, origin, and clone-root mismatch;
- successful deletion while preserving the remote branch;
- forged, expired, and reused deletion capabilities;
- late unsaved buffers and late HEAD changes;
- partial removal failure with registry retention; and
- cancellation and non-following disk measurement; and
- one-time, expiring, malformed, and replaced restart-safe release intents.

## Native Windows release gate

Run these checks in a native Windows Extension Development Host using a
disposable clone root and disposable Git remote. Do not use production data.

1. Materialize, commit, Push and Release, and verify:
   - the local checkout is absent;
   - the registry entry is absent;
   - the remote branch equals the pushed commit and remains browseable; and
   - the window returns to the remote catalog.
2. Materialize and run normal Release without an upstream; verify it succeeds
   only with remote reachability and no local-only refs.
3. Verify release blocks for dirty/staged/untracked files, unsaved text and
   notebook buffers, active Git operations, detached/wrong branch, and network
   failure.
4. Introduce a directory junction/reparse component in a disposable recorded
   path and verify assessment blocks before push or deletion.
5. Replace or move the checkout after confirmation and verify final revalidation
   blocks deletion.
6. Hold a file handle open during removal and verify failure retains the registry
   record and does not offer force deletion.
7. Verify cancellation during fetch/measurement leaves the checkout and registry
   unchanged.

Record the Windows version, VS Code version, Git version, filesystem, credential
helper, and observed results. Only after every item passes may the native Windows
release gate be marked complete.
