# Marketplace Publishing

RepoShelf's Visual Studio Marketplace identity is `chiefwizard.reposhelf`. The
source repository remains `jwhitten37-dev/RepoShelf`; the Marketplace publisher
and GitHub owner are independent identities.

The normative versioning, provenance, signing-boundary, license, publisher
recovery, and rollback controls are in the
[Phase 7.3 release governance gate](./phase-7/RELEASE-GOVERNANCE-GATE.md).

## Authentication

Publishing uses Microsoft Entra ID workload identity federation and a
user-assigned managed identity. No Marketplace Personal Access Token is stored
in the repository or pipeline.

The Azure DevOps project provides an Azure Resource Manager service connection
named `Azure`. Its federated managed identity must be a member of the
`chiefwizard` Marketplace publisher with the **Contributor** role. The pipeline
uses that service connection through `AzureCLI@2` and publishes with:

```text
vsce publish --packagePath <validated-vsix> --azure-credential
```

Never add a PAT, client secret, certificate, federated token, service-connection
identifier, tenant identifier, subscription identifier, or managed-identity
resource ID to this repository.

## Pipeline behavior

`azure-pipelines.yml` separates validation from publication:

1. Every `main` update, pull request, and `v*` tag installs the locked dependency
   graph with Node.js 24.21.0.
2. Formatting, linting, type checking, the lockfile license policy, all tests,
   compilation, and a high-severity dependency audit must pass.
3. The pinned local `@vscode/vsce` packages one VSIX.
4. `npm run package:vsix -- --out-dir <directory>` creates the candidate through
   the pinned local `@vscode/vsce`, validates the payload and final archive against
   explicit allowlists, and verifies the packaged `chiefwizard.reposhelf` identity,
   version, workspace extension kind, and entry point.
5. The validated VSIX and its JSON evidence file are retained as an Azure Pipeline
   artifact. Evidence includes only public package metadata, exact file lists,
   byte size, and SHA-256; it contains no environment dump or credentials.
6. Only a `v*` tag can enter the publishing stage. The tag must exactly equal
   `v<package.json version>` and identify a commit contained in `origin/main`.
7. The publishing stage downloads that exact VSIX without rebuilding it,
   independently compares its identity and SHA-256 with the retained evidence,
   verifies that the current Entra principal has a role on the `chiefwizard`
   publisher, and only then publishes it.

Ordinary `main` and pull-request builds never publish.

The pipeline currently packages and publishes with `--pre-release` because
RepoShelf is pre-release software. Removing that flag requires an explicit
release-readiness review and documentation update; a version tag alone does not
authorize a stable Marketplace release.

## Required Azure DevOps controls

Before enabling a release, create or verify the `reposhelf-marketplace`
environment and configure an **Approval** check in Azure DevOps. Limit approval
authority to trusted maintainers. Also restrict use of the `Azure` service
connection to the publishing pipeline rather than granting it to every pipeline.

Environment approvals and service-connection permissions are Azure DevOps
configuration and cannot be enforced solely by repository YAML. A missing or
unauthorized environment/service connection must fail the publishing stage
closed.

Restrict creation of `v*` tags to trusted maintainers. The pipeline confirms that
the tagged commit is contained in `origin/main`, but repository permissions are
the primary control over who can initiate a release.

## Release procedure

Marketplace publication remains gated until the release-readiness phase. When a
reviewed release is approved:

1. Update `package.json` and `package-lock.json` to the intended semantic version.
2. Move the corresponding changelog entries from **Unreleased** to a dated
   release section.
3. Run `npm ci`, `npm run check`, `npm run compile`, and
   `npm audit --audit-level=high` locally. Package into a temporary directory with
   `npm run package:vsix -- --out-dir <directory>` and review both generated files.
4. Merge the reviewed release commit into `main` and confirm normal CI succeeds.
5. Create and push an annotated tag matching the manifest exactly, for example
   `v0.1.0` for version `0.1.0`.
6. Review the Azure Pipeline's validation results and retained VSIX.
7. Approve the `reposhelf-marketplace` deployment only after confirming the
   extension ID, version, commit, package contents, and release notes.
8. Verify the published Marketplace listing and perform clean-install smoke
   testing.

Do not reuse a released version number. If publication fails after the version is
accepted by Marketplace, diagnose the existing version before creating a new
release commit and tag.

## Failure after publication

Published Marketplace versions and their source tags are immutable. Stop further
approvals, preserve sanitized release evidence, and use Marketplace
unpublish/deprecation controls only after reviewing the effect on installed users.
Remediation is a new reviewed SemVer version; do not overwrite an artifact, move a
tag, reuse a version, or claim that Marketplace can force-downgrade installations.
For suspected publisher compromise, disable the service connection and federated
credential, remove untrusted publisher access, revoke sessions, and suspend tag
and environment approval before investigation. Follow the full incident procedure
in the Phase 7.3 gate.
