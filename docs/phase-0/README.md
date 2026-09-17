# Phase 0: Design and Guardrails

## Status

**Design baseline complete.** Phase 0 establishes contracts and safety
boundaries before extension code is created. The decisions in this directory
refine and, where they conflict, supersede the initial wording in
`PHASED-PLAN.md`.

Open corporate-environment values below remain tracked inputs. The VS Code and
Node.js baselines are now sufficient for Phase 1 scaffolding. Server-specific
values block final API compatibility and corporate manual validation rather
than this documented design baseline.

## Confirmed product decisions

| Topic                 | Decision                                                                                             |
| --------------------- | ---------------------------------------------------------------------------------------------------- |
| Development root      | A contributor-controlled RepoShelf checkout                                                          |
| Source-folder Git     | Public GitHub repository; runtime behavior must not depend on source Git metadata                    |
| Initial GitLab target | Corporate self-managed GitLab only                                                                   |
| Runtime environments  | Native Windows and VS Code Remote–WSL                                                                |
| Host relationship     | Independent configuration, secrets, cache, Git, clone root, and workspace registry                   |
| API authentication    | PAT in VS Code `SecretStorage`                                                                       |
| Git authentication    | HTTPS remote and host-native Git credential helper                                                   |
| Production boundary   | Required functionality from Phases 0–6; OAuth and merge-request features remain optional             |
| Instance staging      | One configured instance in Phases 1–5; multi-instance-safe from day one; multiple enabled in Phase 6 |
| Remote content cache  | Bounded memory-only cache in Phases 1–5                                                              |
| Local edit window     | Open a new VS Code window and preserve the remote-browser window                                     |
| Edit one file         | Cone-mode sparse checkout of its containing directory                                                |
| Distribution          | Public source repository; Marketplace distribution follows hardening and release review              |
| Real-server tests     | Mock/local automated testing; documented manual corporate validation later                           |

## Phase 0 deliverables

- `ARCHITECTURE.md`: components, trust boundaries, host placement, and workflows.
- `DATA-AND-URI-CONTRACTS.md`: identifiers, URI identity, settings, state, and
  cache contracts.
- `MANAGED-WORKSPACE-SAFETY.md`: ownership, path containment, Git checks, and
  release rules.
- `SECURITY-THREAT-MODEL.md`: assets, threats, controls, logging, and network
  policy.
- `TESTING-AND-PHASE-GATES.md`: test layers and acceptance gates for all phases.

## Implementation defaults

These are accepted defaults unless later evidence requires an architecture
decision change:

1. TypeScript extension running in the VS Code extension host.
2. A read-only `FileSystemProvider` for the `reposhelffs` scheme.
3. Direct REST calls behind a typed GitLab client abstraction.
4. Native Git through a dedicated process-runner abstraction.
5. Full commit SHA as remote file content identity.
6. Versioned extension-owned marker in every managed checkout.
7. No telemetry by default.
8. No persistent repository file-content cache without security approval.

## Confirmed development environment

| Item                                        | Confirmed value                                                 |
| ------------------------------------------- | --------------------------------------------------------------- |
| VS Code product                             | Microsoft Visual Studio Code, User Setup                        |
| Provisional minimum/current version         | 1.137.0                                                         |
| VS Code commit                              | `645f29cc3176500b4b5762ba887cf2a7f0ffdf2c`                      |
| Windows platform                            | Windows x64, `Windows_NT 10.0.26200`                            |
| VS Code extension-host runtime              | Electron 42.10.0 / Node.js 24.18.1                              |
| Update policy                               | Centrally managed; users are required to update regularly       |
| Remote development                          | VS Code Remote–WSL is available                                 |
| Local extension testing                     | Extension Development Host testing is permitted                 |
| Windows Node/npm                            | Not installed and not required for the WSL-first build workflow |
| WSL development runtime currently installed | Node.js 25.4.0 / npm 11.17.0                                    |
| Selected project runtime                    | Node.js 24 LTS; exact 24.x pin recorded during scaffolding      |

Software Center reports revision 69 and an install date of 2026-04-01, but that
revision is corporate package metadata rather than a VS Code API compatibility
version. Because updates are centrally managed and required, VS Code 1.137.0 is
the provisional compatibility floor for local development. If later corporate
deployment must support an older managed release, `engines.vscode` may be
lowered only after API review and testing against that release.

The Node.js version shown by **Help: About** is VS Code's embedded extension-host
runtime. It does not install `node` or `npm` as Windows command-line tools. The
project build/test runtime will be a separate Node.js 24 LTS installation in
WSL, aligned to the extension host's Node major version.

## Corporate GitLab inputs still required

The following values are configuration/compatibility blockers, not reasons to
guess or broaden access:

- Corporate GitLab version, edition, and upgrade cadence.
- Corporate GitLab base URL and whether it includes a relative URL prefix.
- Required PAT scopes, expiration, and rotation policy.
- Corporate CA, TLS interception, and proxy requirements.
- SSO/SAML limitations, API limits, and disabled GitLab features.
- Approved HTTPS Git credential helpers for native Windows and WSL.
- Confirmation of any corporate requirement to support a VS Code release older
  than 1.137.0 before organization-wide use.

Phase 1 may now be scaffolded against VS Code 1.137.0. GitLab API features must
remain capability-aware until the server profile is known.

## Tooling observation

The Phase 0 environment inspection found Node.js 25.4.0 and npm 11.17.0 in WSL.
Node 25 is not the project baseline. Phase 1 will pin Node.js 24 LTS for
reproducible builds and tests before dependencies are installed. A Windows-side
Node installation is not required for the current WSL-first development flow.

## Change control

An architectural contract may be changed when implementation or corporate
validation supplies new evidence. Record the reason, affected phases, data
migration impact, and security impact in this directory before changing code.
