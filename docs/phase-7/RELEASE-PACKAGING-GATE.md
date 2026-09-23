# Phase 7.1: Release Packaging Gate

## Scope

Phase 7.1 creates and validates the exact pre-release VSIX candidate. It does not
publish, install, sign, or approve the candidate. Marketplace publication remains
tag-, pipeline-, and environment-approval-gated.

## Shared command

After `npm ci`, `npm run check`, and `npm run compile`, run:

```text
npm run package:vsix -- --out-dir <empty-or-reviewed-output-directory>
```

The command uses the repository-pinned `@vscode/vsce`; no globally installed
packager is trusted. Linux CI, Azure Pipelines, native-Windows CI, and local release
review use this same entry point.

## Required controls

1. The manifest must identify `chiefwizard.reposhelf`, use a non-empty version,
   run as a workspace extension, and load `./dist/extension.js`.
2. The pre-package payload must exactly match the reviewed allowlist.
3. The final ZIP central directory must exactly match the reviewed archive
   allowlist, including only VSIX metadata and the approved extension payload.
4. Development source, tests, scripts, editor/CI configuration, dependency trees,
   environment files, certificates, keys, and nested VSIX files are prohibited.
5. The manifest is read back from the produced VSIX and revalidated; its version
   must equal the source manifest version.
6. Packaging emits one VSIX and one mode-`0600` JSON evidence file containing only
   extension ID, version, pre-release status, exact file lists, byte size, and
   SHA-256.
7. The publishing stage downloads and publishes the validated VSIX without
   rebuilding it. The evidence file is retained for review and is not published.

## Reviewed payload

- `LICENSE`
- `README.md`
- `dist/extension.js`
- `dist/extension.js.map`
- `package.json`
- `resources/reposhelf-activitybar.svg`
- `resources/reposhelf-icon.png`

Any payload change requires review and an explicit allowlist update. Expanding the
allowlist merely to make a failing package pass is prohibited.

## Listing media decision

The MVP does not include screenshots. No safely sanitized representative GitLab
dataset is available, and corporate instances, organization trees, repositories,
paths, or account data must not be exposed for listing media. RepoShelf uses its
provider-neutral icon, banner, listing copy, and accessible text instead. This is
an intentional privacy control, not a release-gate failure.

## Remaining manual gate

- Confirm the evidence extension ID, version, file names, byte size, and SHA-256.
- Install that exact VSIX into a clean VS Code profile without the development
  checkout supplying files.
- Run sanitized native-Windows and Remote–WSL activation and command smoke tests.
- Confirm uninstall/reinstall behavior and that no private environment data is
  retained in release evidence.
