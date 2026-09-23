# Phase 7.2: Marketplace Listing and Disclosure Gate

## Scope

Phase 7.2 prepares accurate Marketplace-facing metadata, README content, privacy
disclosures, limitations, and accessible provider-neutral media. It does not
authorize publication or stable-release promotion.

## Required controls

1. The public identity is `chiefwizard.reposhelf` with the provider-neutral
   RepoShelf name, icon, banner, and tagline.
2. The short description and keywords describe implemented behavior and remain
   within Marketplace limits.
3. The Marketplace README documents requirements, first use, current features,
   managed-workspace retention/release behavior, corporate network boundaries,
   privacy/security posture, support, and current limitations.
4. Feature claims cover multi-instance GitLab browsing, project search, immutable
   remote files, explicit remote branch creation, local materialization, the Local
   Workspaces dashboard, safety assessment, push verification, and fail-closed
   release.
5. The listing explicitly says that OAuth, merge-request integration, persistent
   offline source caching, and in-place sparse expansion are not implemented.
6. The privacy disclosure covers GitLab API and native-Git network data, settings,
   SecretStorage, extension global storage, managed workspaces, memory-only remote
   file caching, logs/redaction, user controls, and no telemetry.
7. Relative README links and the banner are rewritten by pinned `@vscode/vsce` to
   public `jwhitten37-dev/RepoShelf` URLs on the `main` branch.
8. The README contains no stale internal phase status or unsupported production
   claim.

## Screenshot decision

The MVP listing intentionally contains no screenshots. No safely sanitized
representative GitLab dataset is available. Corporate instance names, organization
trees, repositories, project/account identities, paths, and source must not be
captured merely to provide Marketplace media. The provider-neutral icon and banner
plus descriptive, accessible copy are sufficient for the initial listing.

## Automated evidence

- Manifest tests lock the extension ID, display name, description, core keywords,
  and 30-keyword Marketplace limit.
- Listing tests lock current capability and limitation claims, no-telemetry and
  storage disclosures, and removal of stale Phase 4 status.
- Packaging validates the exact VSIX allowlist and the packaged manifest.
- Candidate inspection confirms the packaged banner and disclosure links resolve
  to public repository paths on `main`.

## Remaining manual gate

- Review the rendered Marketplace details page in light and dark themes.
- Confirm banner alt text and heading order are meaningful with a screen reader.
- Check every external link from the Marketplace rendering.
- Confirm the candidate's feature and limitation claims against the exact release
  commit before approving publication.
