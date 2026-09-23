# RepoShelf Product Identity

## Name and positioning

- **Product name:** RepoShelf
- **Tagline:** Remote-first repository workspaces for VS Code.
- **Short description:** Browse repositories remotely and materialize guarded
  local workspaces only when normal editing and Git tooling are needed.
- **Current provider:** GitLab. Provider names should appear as small badges or
  capability labels rather than as the primary product identity.

RepoShelf is an independent project and is not affiliated with, endorsed by, or
sponsored by GitLab Inc., GitHub, Inc., or Microsoft Corporation.

## Visual direction

| Role                | Color  | Hex       |
| ------------------- | ------ | --------- |
| Primary             | Indigo | `#4F46E5` |
| Foundation          | Slate  | `#334155` |
| Materialized/active | Teal   | `#14B8A6` |
| Secondary           | Violet | `#7C3AED` |
| Remote-only accent  | Cyan   | `#22D3EE` |
| Success accent      | Mint   | `#6EE7B7` |
| Highlight accent    | Lime   | `#A3E635` |
| Cleanup attention   | Amber  | `#F59E0B` |

- Slate communicates remote-only state.
- Teal communicates materialized local state.
- Amber is reserved for cleanup attention, not ordinary activity.
- Icons must remain legible in light, dark, and high-contrast VS Code themes.
- Do not use a provider logo as the RepoShelf primary mark.

The provider-neutral visual identity is integrated through:

- `resources/reposhelf-icon.png`: 256×256 Marketplace and Extensions view icon.
- `resources/reposhelf-activitybar.svg`: centered, single-color 24×24 Activity
  Bar icon.
- `docs/images/reposhelf-banner.png`: 1600×400 README and Marketplace details
  banner.

Marketplace screenshots are intentionally omitted from the MVP listing because no
safely sanitized representative GitLab dataset is available. Corporate instances,
organization trees, repositories, paths, and account data must not be captured or
published merely to provide screenshots. The provider-neutral icon, banner, clear
feature descriptions, and accessible text carry the initial listing presentation.
Screenshots may be reconsidered only if a fully synthetic isolated dataset becomes
available after the MVP release.

## Metadata tracking

| Field                 | Value/status                     |
| --------------------- | -------------------------------- |
| Extension ID          | `chiefwizard.reposhelf`          |
| Package name          | `reposhelf`                      |
| Source repository     | `jwhitten37-dev/RepoShelf`       |
| License               | Apache-2.0                       |
| Marketplace publisher | `chiefwizard` (confirmed)        |
| Telemetry             | None                             |
| Release status        | Pre-release; Phase 7 preparation |
