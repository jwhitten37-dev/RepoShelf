# Phase 1: GitLab Connection and Remote Catalog

## Status

The Phase 1 implementation baseline is complete and passes automated local
validation. A user also completed a successful live smoke test from a
WSL-connected Extension Development Host against the corporate self-managed
GitLab. The test confirmed PAT authentication, group/subgroup/project hierarchy,
permission-filtered visibility, and access to an authorized private project.
No server URL, username, PAT, group name, or project name is recorded here.

## Implemented capabilities

- TypeScript VS Code workspace extension targeting VS Code 1.137.0.
- Node.js 24.21.0 development/build/test pin through `mise`.
- One enabled corporate self-managed GitLab instance in Phases 1–5.
- Stable UUID-based instance identity suitable for later multi-instance use.
- PAT capture through a password input and storage in VS Code `SecretStorage`.
- Connection test through `GET /api/v4/user` before settings are committed.
- GitLab Activity Bar container and lazy **Remote Catalog** tree.
- Hierarchical top-level groups, direct subgroups, direct group projects, and
  authenticated user's personal projects.
- Complete Link-header pagination with a hard page safety limit.
- HTTPS-only instance URLs, while retaining relative self-managed base paths.
- Exact-origin and exact-API-path authorization boundary.
- Manual redirect handling that refuses to forward a PAT across that boundary.
- Request timeout, user cancellation, typed error categories, and redacted
  output logging.
- Strict parsing of GitLab response fields used by the catalog.
- Refresh and connection-test commands.

Remote repository trees and files are intentionally deferred to Phase 2. Phase
1 catalog browsing does not invoke Git or create a local repository.

## Local development

Open your RepoShelf checkout in the WSL-connected VS Code window.

Run the automated checks from a WSL terminal:

```bash
cd /path/to/RepoShelf
mise exec -- npm run check
mise exec -- npm run compile
```

To test the UI locally:

1. Open **Run and Debug** in VS Code.
2. Select **Run RepoShelf Extension**.
3. Press `F5` to launch an Extension Development Host.
4. Open the **RepoShelf** Activity Bar view.
5. Select **Add GitLab Instance**.
6. Enter the corporate GitLab HTTPS base URL, including any relative URL prefix.
7. Enter a display label and PAT.
8. Verify that the connection reports the authenticated username.
9. Expand **Groups**, a group, a subgroup, and **Personal Namespace**.
10. Run **RepoShelf: Test GitLab Connection** and **Refresh Catalog**.

Use a least-privilege PAT approved by corporate policy. The token is never
written to settings or logs. Do not paste a production PAT into test source,
terminal commands, screenshots, or issue reports.

## Expected local observations

- The instance appears as the root with its hostname as a description.
- API calls occur only when a tree node is expanded.
- Group expansion shows direct subgroups and direct projects.
- Empty nodes show an explanatory message.
- Authentication, authorization, TLS, network, timeout, and server failures have
  distinct user messages; redacted details appear in the **RepoShelf**
  output channel.
- No project checkout or clone directory is created.

## Pre-Phase-2 manual gate

**Status: passed.** The successful live catalog test and follow-up checks cover
the Phase 1 local gate:

1. **Connection command passed:** it reported the authenticated identity.
2. **Refresh command passed:** both the view button and command executed. The
   original implementation intentionally reloaded lazily and gave no visible
   confirmation; a status-bar confirmation and output log were added after this
   usability observation.
3. **Persistence passed:** after closing and reopening the Extension Development
   Host, the instance configuration and PAT-backed connection remained usable
   without entering credentials again.
4. **Remote-only behavior passed:** navigating groups, subgroups, and projects
   created no checkout or clone in the development folder.
5. **Invalid-token behavior passed:** a bad PAT failed once without entering a
   retry loop. No sensitive token value is recorded here.

The refresh operation clears cached clients and user data, fires the tree change
event, and reloads nodes from GitLab when they are expanded. It does not eagerly
reload every group because that would defeat lazy loading and create unnecessary
API traffic.

Record only pass/fail and nonsensitive observations. Never record the PAT or
internal server/project identifiers in this repository.

## Known Phase 1 boundaries

- The UI supports one configured instance and does not yet provide remove/edit
  commands. During development, the non-secret instance record can be cleared
  through the `reposhelf.instances` setting. A stored PAT remains isolated
  in `SecretStorage`; lifecycle removal is added with the multi-instance
  management workflow before organizational use.
- Corporate GitLab version, PAT scopes, CA/proxy behavior, and server-specific
  compatibility still require manual validation.
- Native Windows runtime behavior remains a release gate, but the current build
  and automated tests run in WSL.
- Phase 1 uses mocked HTTP and does not send requests during automated tests.

## Automated validation coverage

- Instance schema and one-enabled-instance policy.
- HTTPS and self-managed relative-base-path normalization.
- PAT/header and credential-bearing URL redaction.
- API URL construction without credentials.
- Same-origin redirect acceptance and cross-origin/path-boundary rejection.
- HTTP authentication, authorization, missing-resource, rate-limit, and server
  error mapping.
- Authenticated-user response parsing.
- Link-header pagination.
- Top-level group and direct-project query parameters.
- Invalid collection response rejection.
