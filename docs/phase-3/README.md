# Phase 3: Controlled Local Materialization

## Status

**Implementation, automated validation, and manual corporate validation passed.**
The manual gate covered sparse and full materialization, existing-workspace
reuse safeguards, branch handling, and private Git-directory ownership markers.
Only pass/fail results are retained; no corporate identifiers are recorded.

## Implemented capabilities

- **Edit Locally** actions on remote projects, folders, and files.
- File editing materializes its containing directory using partial clone and
  cone-mode sparse checkout, then opens the selected file.
- Folder editing materializes that directory and reveals it in Explorer.
- Project editing offers:
  - Partial + sparse checkout of a repository-relative directory.
  - Full clone with normal branch and tag refs.
- Root-level file editing uses a valid cone-mode root-only sparse checkout.
- Every checkout opens in a new VS Code window while the remote browser remains
  open.
- Windows and WSL use independent machine-scoped clone-root settings.
- The default WSL clone root is:

  ```text
  ~/reposhelf-workspaces
  ```

- Native Git is spawned with argument arrays and no shell.
- Git authentication uses the host's HTTPS credential helper. The API PAT is
  never inserted into the Git URL or process arguments.
- Git operations are non-interactive, cancellable, timeout-bounded, and have
  bounded captured output.
- Cancellation waits for the child process to exit before guarded cleanup.
- Partial+sparse checkouts validate:
  - `remote.origin.promisor=true`
  - `remote.origin.partialclonefilter=blob:none`
  - `core.sparseCheckout=true`
- The cloned branch HEAD must equal the exact commit SHA pinned by remote
  browsing. If the branch moved, materialization fails and removes only the
  marked temporary checkout.
- Git repository top-level, private Git directory, origin URL, current branch,
  and full HEAD SHA are validated before final placement.
- Completed workspaces contain a versioned ownership marker under:

  ```text
  <git-dir>/reposhelf/workspace.json
  ```

- Host-local workspace metadata is recorded in VS Code extension state.
- Existing workspaces are reused only after ownership, path, repository, branch,
  origin, and sparse-scope validation.
- A sparse checkout is not silently reused as a full clone or for a different
  sparse directory. Sparse expansion is deferred to Phase 5.
- If GitLab reports that the selected branch is not pushable, the user must
  provide a different editable local branch name. The new local branch starts at
  the pinned selected-branch SHA and does not create or modify a remote branch.
- Temporary clone directories use a separate sibling operation marker and are
  cleaned only when that marker identifies the exact temporary directory.
- Clone roots reject filesystem roots, home/profile roots, extension-source
  overlap, path escape, and symlink components.

## Important Phase 3 boundary

Phase 3 creates local workspaces but does **not** implement extension-managed
release/deletion. Safe Push and Release belongs to Phase 4. Closing a window is
never permission to delete a checkout.

For manual Phase 3 testing, use a dedicated disposable clone root containing
only test materializations. If cleanup is needed before Phase 4 exists, close
all windows using those test checkouts and manually remove only that dedicated
test root after independently verifying its path. This is test-environment
cleanup, not an extension release workflow.

## Automated validation

```bash
cd /path/to/RepoShelf
mise exec -- npm run check
mise exec -- npm run compile
```

Automated tests use only disposable repositories under the system temporary
directory. Production materialization accepts HTTPS Git URLs only; `file://` is
enabled solely through a test-only service constructor.

## Manual corporate GitLab test

### Preparation

1. Restart the Extension Development Host with `F5`.
2. Use a small authorized test project that can safely be cloned.
3. Verify the WSL Git credential helper can authenticate to the project's HTTPS
   clone URL. Do not put credentials or the API PAT in a URL or terminal command.
4. Use a dedicated test clone root, for example:

   ```text
   ~/reposhelf-phase3-test
   ```

5. Ensure that root does not contain unrelated files.

### File materialization

1. In the remote catalog, select a branch and expand a project folder.
2. Click **Edit Locally** on a file inside a non-root directory.
3. Confirm the modal describes the containing-directory sparse scope.
4. Enter the dedicated test clone root.
5. Confirm a new VS Code window opens with the managed checkout.
6. Confirm the selected file opens automatically.
7. Confirm files in the selected directory and root-level repository files are
   present, while an unrelated directory is absent.
8. In the new window's terminal, run these read-only checks:

   ```bash
   git branch --show-current
   git rev-parse HEAD
   git config --get remote.origin.promisor
   git config --get remote.origin.partialclonefilter
   git sparse-checkout list
   git remote get-url origin
   ```

9. Confirm the branch and SHA match the remote browser, the promisor value is
   `true`, the filter is `blob:none`, and the sparse directory is correct.
10. Confirm the origin is HTTPS and contains no embedded credentials.

### Folder and root-file behavior

1. Test **Edit Locally** on a folder using a different project branch or a fresh
   dedicated clone root.
2. Confirm the folder is revealed in Explorer.
3. If the test project has a root-level file, materialize it and confirm root
   files are present while nested directories remain absent.

### Full clone behavior

1. Choose **Edit Locally** on a project that does not already have a sparse
   checkout for the same target branch/path allocation.
2. Select **Full clone**.
3. Confirm the complete worktree is present.
4. Confirm normal remote branch and tag refs are available where the test
   repository has them.
5. Confirm the selected branch and pinned SHA are correct.

### Existing-workspace reuse

1. Repeat the same materialization action for an already-created workspace.
2. Confirm the validated existing workspace is reused and opens in a new window.
3. Try requesting a different sparse directory for the same project/target
   branch. Confirm the extension blocks it with a message that sparse expansion
   is deferred, rather than pretending the requested files exist.

### Non-pushable/protected branch behavior

If an authorized test branch is reported as non-pushable:

1. Select **Edit Locally**.
2. Confirm the extension requests a different editable local branch name.
3. Enter a harmless test branch name.
4. Confirm the local checkout uses the new branch at the exact selected ref SHA.
5. Confirm no remote branch was created and no remote content changed.

Do not push as part of the Phase 3 validation. Commit/push/release lifecycle
testing begins in Phase 4.

### Ownership and remote safety

1. Locate the private Git directory:

   ```bash
   git rev-parse --absolute-git-dir
   ```

2. Confirm `reposhelf/workspace.json` exists beneath that private Git
   directory, not in the worktree.
3. Confirm browsing/materialization did not alter any remote GitLab branch,
   commit, tag, or file.
4. Confirm the RepoShelf source repository contains no materialized project
   checkout.

## Expected limitations

- Tags and direct commit refs are not exposed by the Phase 2 UI, so their
  editable-branch flows remain deferred.
- Sparse checkout expansion is deferred to Phase 5.
- Safe release/deletion, push verification, and disk dashboard are not present
  until later phases.
- HTTPS Git authentication must already be available through the host credential
  helper. The extension does not display an interactive credential prompt.
- Native Windows materialization remains a separate release-gate test; the
  current development validation is WSL-first.

Never record corporate URLs, credentials, project names, branch names, file
contents, or local personnel identifiers in this repository when documenting
manual results.
