# Phase 2: Branch-Aware Remote Repository Browser

## Status

**Implementation and manual corporate validation passed.** The Phase 2 baseline
passes automated local validation and a live smoke test from a WSL-connected
Extension Development Host against the corporate self-managed GitLab. No
corporate URL, PAT, username, branch name, file content, or project identifier
is recorded here.

The live test confirmed:

- Projects expose repository files, branches, and resolved commit SHAs.
- Partial-name branch search returns selectable matching branches.
- Switching branches refreshes the tree while preserving already-open pinned
  documents.
- A path present on both branches offers **Open New Ref**, **Compare Refs**, and
  keeping the current pinned revision; native comparison works.
- A path absent from the selected branch leaves the prior document open and
  displays the expected non-destructive prompt.
- A non-default selected branch persists across Extension Development Host
  restarts and is restored when the project is revisited.
- Remote browsing, branch switching, opening, and comparing created no clone or
  checkout.

## Implemented capabilities

- Project nodes expand into a selected branch context and repository root.
- The project default branch is selected initially.
- Selected branches persist per instance/project in host-local extension state.
- Branch selection searches GitLab from a user-entered term instead of eagerly
  loading every branch.
- Every selected branch resolves to its full commit SHA.
- Repository folders load lazily against the resolved commit.
- Files open through immutable `reposhelffs:` URIs containing instance UUID,
  project ID, repository path, full commit SHA, and display branch.
- `reposhelffs:` is registered as case-sensitive and read-only.
- Open files remain pinned when the selected project branch changes.
- If the active file exists on the new branch, the user can open the new pinned
  revision or compare it with the old revision using VS Code's native diff.
- If the active file does not exist on the new branch, the old document remains
  open and the user is offered **Browse New Ref**.
- A status-bar item displays the active remote document's branch and abbreviated
  pinned SHA.
- Remote bytes use a bounded in-memory LRU-like cache with concurrent-request
  deduplication. File bodies are not persisted to disk.
- A hard 50 MiB safety limit prevents unbounded remote file reads.

Phase 2 supports branch refs. Tag selection and direct commit entry remain
deferred as permitted by the phased plan. No Git command or clone is used for
remote browsing.

## Local automated validation

```bash
cd /path/to/RepoShelf
mise exec -- npm run check
mise exec -- npm run compile
```

## Manual corporate GitLab test — passed

Restart the Extension Development Host with `F5` so it loads the latest bundle.
Use a small authorized test project with at least two branches. For the
missing-file flow, it is useful if one harmless test file exists on only one
branch.

### Repository browsing

1. Open **RepoShelf** and navigate to a project with a default branch.
2. Expand the project.
3. Confirm the first child shows `Ref: <default branch>` and an abbreviated SHA.
4. Confirm root repository files/folders appear below it.
5. Expand nested folders and verify each loads only when expanded.
6. Open a text file.
7. Confirm the editor is read-only and the status bar shows the branch plus SHA.
8. Hover the tree file/ref nodes and confirm branch/SHA context is visible.

### Branch selection and immutable documents

1. With a remote file open, click the project's branch icon or the `Ref:` row.
2. Enter part of another branch name.
3. Select the branch from the quick pick.
4. Confirm the project tree refreshes and displays the selected branch/SHA.
5. Confirm the previously open tab did not silently change content.
6. If the same path exists on both branches, test **Open New Ref** and
   **Compare Refs**.
7. Confirm the old and new editor URIs/revisions remain independent.
8. Restart the Extension Development Host and confirm the selected project
   branch is restored.

### Missing-file behavior

1. Open a file that is absent from another test branch.
2. Switch the project to that branch.
3. Confirm the old pinned file remains open.
4. Confirm the message states that the path is absent from the new branch.
5. Select **Browse New Ref** and confirm focus returns to the remote catalog.

### Read-only and remote-only guarantees

1. Attempt to type into an opened `reposhelffs:` document and confirm VS Code does
   not permit saving changes to it.
2. Use **Save** or **Save As** carefully: direct save to the same `reposhelffs:` URI
   must be rejected; **Save As** to an ordinary local path is a normal VS Code
   copy operation and does not modify GitLab.
3. Refresh the catalog and reopen a file to exercise cache clearing.
4. Confirm browsing, branch switching, opening, and comparing files create no
   project clone or checkout.

## Expected limitations

- Binary files are delivered as bytes, but VS Code decides whether/how to render
  them.
- Files larger than 50 MiB are rejected with a clear error.
- Branch search requires at least one search character to avoid loading an
  organization's full branch list.
- Tags and direct commit entry are not exposed yet.
- A branch deleted after it was persisted produces a useful load error; select
  another branch from the project action.

## Automated test coverage

- Branch search, branch-name encoding, and full-SHA validation.
- Lazy repository-tree path/ref parameters and entry parsing.
- Raw-file path encoding and binary byte retrieval.
- 50 MiB hard file-size rejection.
- Immutable URI construction/parsing and unsafe-path rejection.
- Cache deduplication, LRU eviction, oversized bypass, and failure retry.
- Existing Phase 1 authentication, pagination, origin, redirect, and redaction
  coverage.

Never record corporate URLs, PATs, usernames, branch names, file contents, or
project identifiers in this repository when documenting manual results.
