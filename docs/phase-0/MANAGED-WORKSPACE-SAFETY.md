# Managed Workspace Safety

## Safety invariants

1. The extension never deletes remote GitLab data.
2. Local deletion is explicit, confirmed, and limited to a proven
   extension-owned checkout below the current host's configured clone root.
3. Registry metadata alone never proves ownership or safety.
4. A dirty, ambiguous, unreachable, externally moved, or structurally unsafe
   checkout is not deleted.
5. There is no force-delete command.
6. Closing any window, losing a coordinator, stopping a heartbeat, expiring a
   lease, completing a push, or reaching an age/inactivity threshold never
   independently authorizes deletion.
7. Coordination journals, release requests, and reminder state are not deletion
   capabilities.
8. Ignored by Git does not mean disposable; ignored local content is classified
   conservatively and unknown content blocks release.

## Managed path allocation

Paths must be unique across instances, projects, and branch materializations.
A recommended human-readable layout is:

```text
<cloneRoot>/<instance-id>/<project-id>-<project-slug>/<branch-slug>-<short-hash>/
```

Slugs are convenience only. IDs/hashes establish uniqueness. User-controlled
names are sanitized for reserved Windows names, illegal characters, trailing
dots/spaces, path length, case collisions, and separators.

Clone into a random temporary sibling below the clone root. Never clone over an
existing directory. Final placement uses an atomic rename where supported.

## Ownership marker

Every completed checkout contains a marker in its private Git directory at:

```text
<git-dir>/reposhelf/workspace.json
```

The marker contains the `ManagedWorkspaceRecord` identity fields, a marker
schema version, creation nonce, and expected canonical clone root. It contains
no PAT, credential, or API response.

The marker must not be placed in the worktree: doing so could alter Git status
or collide with content controlled by the remote repository. Phase 3 uses a
normal standalone checkout with a private `.git` directory. If Git worktrees
are introduced later, marker placement and shared/common Git-directory behavior
require a new reviewed contract.

Before release, registry and marker must agree on workspace ID, instance ID,
project ID, repository URL, branch, and canonical local path. Unknown marker
versions fail closed.

The marker proves extension intent, not current safety; every release reruns all
filesystem and Git checks.

## Filesystem containment validation

Before creating or deleting anything:

1. Require an absolute configured clone root and target path.
2. Canonicalize the existing clone root using real-path facilities.
3. Resolve the target without relying on string-prefix comparison.
4. Confirm the target is a strict descendant, not equal to the root.
5. Walk every existing path component from root to target using no-follow/lstat
   semantics.
6. Block symbolic links on WSL/Linux.
7. Block junctions, mount points, and other reparse points on Windows unless a
   later reviewed implementation can prove a safe subtype.
8. Re-canonicalize immediately before deletion and compare against the marker
   and registry.
9. Refuse filesystem roots, home/profile paths, the extension source folder,
   and any path that cannot be conclusively classified.

Deletion code must receive a validated opaque capability produced by the
immediately preceding checks, not an arbitrary string path.

## Git safety snapshot

Release validation obtains a fresh, machine-readable Git snapshot including:

- Repository top-level and common Git directory.
- Current branch and full `HEAD` SHA.
- Configured remotes and normalized expected origin URL.
- Index/worktree/untracked status using porcelain output.
- Upstream and ahead/behind state, if configured.
- Local branches, tags, and other refs.
- Merge, rebase, cherry-pick, revert, bisect, sequencer, or lock state.
- Sparse-checkout configuration where applicable.

Git invocations use argument arrays, `--` where relevant, stable machine
formats, disabled pagers, and a controlled non-interactive environment.

## Unsaved editor safety

Release is blocked if any dirty text document or notebook has a filesystem URI
strictly within the checkout. The implementation must also ask VS Code to close
or remove the workspace only after all safety checks pass. Untitled documents
without a filesystem association do not block this checkout unless VS Code
reports that they belong to it.

## Release Local Workspace

Normal release is allowed only if all common safety checks pass and:

1. Fetch/remote verification completes successfully.
2. Local `HEAD` is reachable from the intended selected remote ref.
3. No local branch, tag, or other user-created ref contains commits that would
   become inaccessible after deletion.
4. There are no staged, unstaged, untracked, ignored-but-extension-relevant, or
   ongoing-operation states that could represent work.

A missing upstream is acceptable only when the remote-reachability and
local-only-ref proofs succeed. Network failure or ambiguous reachability blocks
release.

Closing a managed workspace without Release preserves its checkout and registry
record regardless of whether it is clean or contains local work. A later Edit
Locally action must revalidate ownership, canonical path, Git identity, origin,
branch, and clone mode before reopening the same checkout. It must never clone
over or overwrite a retained allocation.

## Push and Release Local Workspace

Push and Release additionally requires:

1. A target remote branch is explicit.
2. Push exits successfully without an authentication or policy error.
3. The remote ref is refreshed after push.
4. Remote ref SHA equals local `HEAD`, or another reviewed proof demonstrates
   the pushed commit is safely reachable.
5. Local `HEAD` is not ahead of the remote target.

The extension does not silently create a commit. Users stage and commit through
VS Code SCM/native Git first.

## Deletion sequence

1. Display project, branch, canonical path, and disk size; obtain explicit
   confirmation.
2. Check associated unsaved documents.
3. Produce filesystem and Git safety snapshots.
4. Perform push/remote proof when requested.
5. Revalidate path containment and ownership to reduce time-of-check/time-of-use
   risk.
6. Persist an expiring release intent that identifies the workspace and confirmed
   HEAD but grants no deletion authority.
7. Close/remove the local workspace from VS Code. If this restarts the extension
   host, consume the intent and rerun fresh remote, ownership, path, Git, HEAD,
   ref, registry, and unsaved-buffer checks in the empty restarted host.
8. Mint a new short-lived in-memory deletion capability only from those fresh
   checks, then delete only that checkout without following links.
9. Verify absence, then remove its registry entry.
10. Refresh remote metadata and retain the remote branch context.

If deletion partially fails, retain/reconstruct the registry record, log the
remaining canonical path, and offer diagnostics—not force cleanup.

Phase 4.1 may transfer an explicitly confirmed release request to an original
catalog coordinator. The request is workspace-specific, expiring, single-claim,
and not deletion authority. After the managed session detaches, the claimant
reruns every fresh safety proof and mints a new in-memory capability. If push
verified but handoff or closure fails, the pushed state is retained for
reconciliation and the local checkout is not deleted.

Workspace-age reminders may offer Review and Release, Close Window while keeping
the local copy, Keep Open, or Remind Me Later. They never perform unattended
release. Multiple workspaces have independent coordination and reminder state.

## Temporary and stale directories

Incomplete clone directories use a random sibling marker, not repository
content, for example `<temporary-name>.reposhelf-temp.json`. The marker
contains the exact temporary directory basename, operation ID, creation time,
and random nonce. It is written before clone starts and removed after the final
ownership marker and registry entry are committed.

A temporary directory can be cleaned only if it is under the clone root, its
sibling marker validates and names it exactly, the operation is not active in
this host, and both paths pass link/reparse checks. The marker and directory are
removed as one guarded cleanup operation. Age alone is never deletion
authority.
