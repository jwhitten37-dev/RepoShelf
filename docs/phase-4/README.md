# Phase 4: Release Safety Foundation

## Status

**In progress.** The first Phase 4 slice is complete as a non-destructive,
fail-closed safety assessment. Push, remote-result verification after push, and
local workspace deletion are not implemented by this slice.

Closing a VS Code window never authorizes deletion.

## Implemented foundation

- `GitSafetySnapshot` provides typed, machine-readable evidence for:
  - dirty staged, unstaged, and untracked state;
  - an attached branch and current commit;
  - ongoing merge, rebase, cherry-pick, revert, bisect, sequencer, and lock state;
  - upstream ahead/behind counts when an upstream exists;
  - a freshly fetched intended origin branch and HEAD reachability from it;
  - local refs containing commits not reachable from any origin ref; and
  - sparse-checkout state.
- The pure decision engine blocks incomplete evidence and independently reports
  dirty Git state, dirty editor buffers, active operations, branch/origin
  mismatch, missing remote target, unpushed HEAD, and local-only refs.
- `RepoShelf: Check Workspace Safety` is available only as a read-only command.
  It fetches origin to obtain fresh evidence but does not push, create or delete
  local refs, release, or delete anything on the remote. Fetch updates local
  remote-tracking refs but does not modify the worktree or local branches.

## Ownership and containment boundary

Assessment requires one open folder that matches the host-local managed
workspace registry. Before fetching, RepoShelf:

1. rejects symbolic-link components in the recorded paths;
2. canonicalizes the recorded clone root and workspace;
3. proves the workspace is a strict descendant of the clone root;
4. requires the Git top level to equal the workspace;
5. requires a standalone private Git directory inside the workspace;
6. parses the versioned private `reposhelf/workspace.json` marker;
7. compares the complete marker identity with the registry record; and
8. requires the current origin to match the canonical ownership record.

Any missing, malformed, ambiguous, moved, linked, or inconsistent evidence
blocks the assessment. No destructive fallback exists.

## Remote and ref semantics

The collector explicitly refreshes all origin branch refs even for clones that
were initially configured with a single-branch refspec. A normal future release
can be considered only when local HEAD is reachable from the freshly fetched
intended remote branch and no local ref contains commits absent from all origin
refs. An upstream is useful diagnostic evidence but is not the sole proof.

## Privacy and diagnostics

User messages and logs report aggregate counts and blocker categories. They do
not log changed file names, ref names, marker contents, repository URLs, or
commit SHAs.

## Automated validation

- Pure decision-table tests cover complete safe evidence, incomplete evidence,
  dirty/unsaved state, active operations, branch and origin mismatch, missing
  remote branches, unpushed HEAD, and local-only refs.
- Parser tests cover porcelain-v2 NUL records, including rename records, and
  ahead/behind output.
- Disposable real-Git component tests create a workspace through the production
  materialization service and verify clean collection, dirty and operation
  detection, local-only refs, marker mismatch, and clone-root containment.

## Remaining Phase 4 gates

- Add an explicit commit workflow without bypassing normal Git safeguards.
- Add push as a separate operation with credential-helper authentication.
- Verify the post-push remote result before any release action.
- Add guarded local deletion with immediate containment/no-follow revalidation,
  explicit confirmation, and partial-failure recovery.
- Validate destructive paths natively on Windows. Development remains WSL-first,
  but native Windows destructive-path validation is a release gate.
