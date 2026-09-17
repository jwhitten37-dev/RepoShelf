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

The current Activity Bar SVG is a provisional provider-neutral shelf/grid mark.
Marketplace icon and listing assets remain deferred until visual review.

## Metadata tracking

| Field                 | Value/status                                         |
| --------------------- | ---------------------------------------------------- |
| Extension ID          | `chiefwizard.reposhelf` (planned)                    |
| Package name          | `reposhelf`                                          |
| Source repository     | `jwhitten37-dev/RepoShelf`                           |
| License               | Apache-2.0                                           |
| Marketplace publisher | `chiefwizard` (confirmation required before release) |
| Telemetry             | None                                                 |
| Release status        | Pre-release; Phase 4 paused                          |
