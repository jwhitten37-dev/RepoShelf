# Phase 7.3: Release Governance and License Gate

## Scope

This gate defines versioning, changelog, provenance, signing boundaries,
publication approval, third-party license review, rollback, and publisher-account
response. It does not waive the Phase 6 or Phase 7.1/7.2 manual gates.

## Version and channel policy

1. `package.json` and `package-lock.json` must contain the same SemVer version.
2. A release tag is annotated, equals `v<manifest version>`, and identifies a
   reviewed commit contained in `main`. Released versions and tags are immutable
   and are never reused or moved.
3. Changelog entries move from **Unreleased** to a dated version section before
   tagging. Release notes describe user-visible changes, security impact,
   limitations, migration requirements, and known issues without private data.
4. `0.x` releases may contain breaking changes but must call them out explicitly.
   Once stable, incompatible behavior requires a major version; compatible
   features require a minor version and compatible fixes require a patch version.
5. RepoShelf publishes as Marketplace pre-release. Stable promotion requires a
   separate reviewed change removing `--pre-release`, successful manual gates on
   the exact candidate, no unresolved release-blocking security or license issue,
   and an explicit approval recorded with the deployment.

## Provenance and signing boundary

- The source commit is bound to an immutable annotated tag and validated as part
  of `main`.
- The pinned Node/npm graph compiles and packages the candidate. The package gate
  records extension identity, version, channel, exact members, byte size, and
  SHA-256 in a mode-`0600` JSON sidecar.
- Azure Pipeline retains the candidate and sidecar as one artifact. Publication
  downloads rather than rebuilds that artifact and independently compares the
  candidate's SHA-256 and identity with the sidecar immediately before publishing.
- RepoShelf does not create or claim a repository-local code signature. VSIX
  signing and verification exposed by the Visual Studio Marketplace are
  Marketplace service boundaries. The repository evidence supplies reviewable
  build provenance, not an Authenticode or maintainer signature.
- Release evidence contains public package metadata only. Build environment dumps,
  tokens, tenant/subscription IDs, private URLs, and corporate test data are
  prohibited.

The approval record, tag, source commit, validation run, retained artifact, JSON
sidecar, dependency audit, license inventory, and post-publication result together
form the release record. Azure artifact retention is a project setting and must be
long enough to support the project's security and rollback obligations.

## Third-party license policy

`npm run license:check` reads the complete npm lockfile graph without network
access. It fails for a missing declaration, an unreviewed license, a malformed
review exception, or any production dependency. RepoShelf currently has no runtime
npm dependency: the bundled extension uses project code and Node/VS Code APIs, and
the exact VSIX allowlist excludes `node_modules`.

The accepted lockfile declarations are `0BSD`, `Apache-2.0`, `Artistic-2.0`,
`BSD-2-Clause`, `BSD-3-Clause`, `BlueOak-1.0.0`, `ISC`, `MIT`, and `MPL-2.0`.
This is a reviewed project policy, not a general statement that every use under
those licenses is automatically acceptable.

`@vscode/vsce-sign` and its optional platform packages declare `SEE LICENSE IN
LICENSE.txt`. Their Microsoft VSCE-SIGN terms permit installation and use with
Visual Studio products and services, including Visual Studio Code and Azure
DevOps, to develop and test applications. RepoShelf uses them only as transitive,
development-only components of the pinned Marketplace toolchain. They are not in
the VSIX and must not be redistributed as a RepoShelf component. A package-family,
declared-license, development/runtime, version, or terms change requires renewed
human review; the automated exception is intentionally narrow.

For each release, save a generated inventory beside private pipeline review
records when required:

```text
npm run license:check -- release-artifacts/licenses.json
```

The inventory contains package names, versions, declared licenses, dependency
classification, policy, and lockfile SHA-256. It contains no environment data.

## Publisher security and recovery

1. The `chiefwizard` publisher uses least privilege. Human owner accounts require
   phishing-resistant MFA and protected recovery methods; contributor access is
   limited to release maintainers and reviewed regularly.
2. Automation uses only Entra workload identity federation through the restricted
   `Azure` service connection. Do not create a Marketplace PAT as a fallback.
3. Restrict `v*` tag creation, pipeline edits, environment approval, service
   connection use, and publisher membership. No single unreviewed source change
   should both alter release automation and authorize its deployment.
4. On maintainer departure or suspected account/service-connection compromise,
   remove publisher membership, disable the service connection/federated
   credential, revoke active sessions and recovery methods, protect tags, and
   suspend deployment approvals before investigating.
5. Keep at least two trusted publisher owners to avoid an unrecoverable single
   account. Recovery uses the Marketplace/Entra administrative process, never
   credentials committed to source or release evidence.

## Rollback and incident response

Marketplace versions are immutable; rollback never replaces a published version
or moves its tag.

1. Stop approvals and disable the publishing identity/service connection.
2. Preserve the affected tag, commit, pipeline logs, sidecar, VSIX hash, listing
   state, and sanitized observations. Never collect user credentials or source.
3. Determine whether the issue is listing-only, functional, security-related, or a
   publisher compromise. Follow `SECURITY.md` for confidential security reports.
4. If Marketplace controls permit, unpublish/deprecate or otherwise suppress the
   affected version. Consider impact on existing installations before removing an
   extension or version; do not claim that Marketplace can force-downgrade users.
5. Fix forward from reviewed source with a new SemVer version, changelog entry,
   tag, complete gate run, artifact, and approval. A previously validated artifact
   is not modified and a version number is not reused.
6. Verify listing/channel state and clean installation after remediation. Publish
   a sanitized advisory when users need to rotate credentials, remove a version,
   or take another action.

## Release approval checklist

- Security review, `npm audit --audit-level=high`, and `npm run license:check` pass.
- All automated checks and Phase 6 mandatory manual gates pass on the release
  commit; Phase 7 clean-install, native Windows, Remote–WSL, uninstall/reinstall,
  rendered listing, links, and accessibility checks pass on the exact candidate.
- Version, dated changelog, annotated tag, commit, pre-release/stable channel,
  extension ID, archive members, evidence SHA-256, and release notes agree.
- Publisher membership, MFA/recovery, tag protection, environment approval, and
  service-connection restrictions have been reviewed outside repository YAML.
- The deployment approver records the decision and post-publication smoke result.
