# Data and URI Contracts

## Identifier rules

All persisted and URI-level identities are stable machine identifiers:

- `instanceId`: generated UUID, never the mutable label or URL.
- `projectId`: GitLab numeric project ID represented as a decimal string.
- `commitSha`: lowercase full SHA returned by GitLab, never an abbreviated SHA.
- `path`: repository-relative POSIX path with no leading slash.
- `workspaceId`: generated UUID for one materialization.

Labels, group paths, project paths, branch names, and instance URLs are display
or lookup metadata. They are not unique storage keys.

## Remote URI contract

The canonical shape is:

```text
reposhelffs://<instance-uuid>/projects/<project-id>/files/<encoded-path>?commit=<full-sha>&ref=<encoded-display-ref>
```

Example:

```text
reposhelffs://d48616b2-70ca-4fe0-91ac-d97e70a0de82/projects/842/files/charts/bootstrap/values.yaml?commit=1a2b...full-sha&ref=feature%2Fupgrade-helm
```

Rules:

1. Scheme is exactly `reposhelffs`.
2. Authority is the immutable `instanceId`; credentials and hostnames never
   appear in the URI.
3. Project ID and full commit SHA define repository identity and revision.
4. Path segments are URI-encoded individually after normalizing Git repository
   separators to `/`.
5. Empty segments, `.`, `..`, NUL, backslash, and a leading slash are rejected.
6. `commit` is required for file-content reads. `ref` is optional display
   metadata and does not determine bytes.
7. Query parameters are emitted in canonical order so equivalent resources
   produce equal URI strings.
8. Fragments are unused and rejected.

The immutable content cache key is `(instanceId, projectId, commitSha, path)`.
The display ref is not part of content identity.

## Core data records

```ts
interface GitLabInstance {
  schemaVersion: 1;
  instanceId: string;
  label: string;
  baseUrl: string;
  enabled: boolean;
}

interface ProjectRefContext {
  instanceId: string;
  projectId: string;
  displayRef: string;
  refType: "branch" | "tag" | "commit";
  resolvedCommitSha: string;
}

interface ManagedWorkspaceRecord {
  schemaVersion: 1;
  workspaceId: string;
  instanceId: string;
  projectId: string;
  canonicalRepositoryUrl: string;
  targetBranch: string;
  cloneMode: "partialSparse" | "full";
  sparseDirectories: string[];
  localPath: string;
  createdAt: string;
  lastOpenedAt: string;
  lastVerifiedAt?: string;
  lastPushedCommitSha?: string;
}
```

These are contract shapes, not permission to persist every object wholesale.
Runtime code must validate data read from settings or storage.

## Storage allocation

| Data                                                       | Store                                                    | Persistence                   |
| ---------------------------------------------------------- | -------------------------------------------------------- | ----------------------------- |
| PAT                                                        | `SecretStorage`, keyed by `instanceId`                   | Persistent, secret            |
| Instance definitions/defaults                              | VS Code settings                                         | Persistent, user controlled   |
| Clone root                                                 | Remote/machine-scoped VS Code setting                    | Persistent per host           |
| Selected refs, favorites, recent projects, sparse profiles | Extension global state                                   | Persistent per extension host |
| Managed workspace registry                                 | Extension global state plus checkout marker              | Persistent per extension host |
| Catalog/tree metadata                                      | Memory initially; safe metadata persistence may be added | Bounded                       |
| Repository file bytes                                      | Memory only in Phases 1–5                                | Bounded, cleared on host exit |
| Git/worktree truth                                         | Filesystem and native Git                                | Authoritative                 |
| Remote truth                                               | GitLab API/server                                        | Authoritative                 |

The registry is an index, not deletion authority. A registry entry without a
valid marker and complete filesystem/Git validation can be forgotten but not
used to delete a path.

## Settings contract

Provisional names are:

```json
{
  "reposhelf.instances": [],
  "reposhelf.cloneRoot": null,
  "reposhelf.defaultCloneMode": "partialSparse",
  "reposhelf.remoteDocumentMode": "pinnedCommit",
  "reposhelf.cleanup.confirmAlways": true,
  "reposhelf.api.timeoutMs": 30000,
  "reposhelf.cache.maxFileBytes": 5242880,
  "reposhelf.cache.maxTotalBytes": 52428800
}
```

Constraints:

- Instance URLs must be valid HTTPS URLs for production. Local development may
  explicitly permit loopback HTTP without weakening production validation.
- Credentials are not settings.
- A clone root must be absolute and must not be a filesystem root, home/profile
  directory, workspace root, or existing non-extension-owned project path.
- Cache values are bounded by hard safety maxima in code.

## Cache behavior

The file cache is an LRU-like bounded byte cache. It must enforce both
per-object and total-byte limits, deduplicate concurrent requests for the same
key, and avoid caching failed/partial responses. An oversized file may be read
for the active request subject to a separate hard maximum, but is not retained.

Ref resolution and tree metadata have short TTLs and explicit refresh. Pinned
file bytes are immutable for a given commit/path and do not need TTL
invalidation, but remain subject to memory eviction.
