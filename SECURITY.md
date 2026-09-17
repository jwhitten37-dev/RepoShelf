# Security Policy

## Supported versions

RepoShelf is pre-release software. Security fixes are applied to the latest
commit on `main`; no released version is currently supported.

## Reporting a vulnerability

Do **not** open a public issue for suspected vulnerabilities. Use
[GitHub private vulnerability reporting](https://github.com/jwhitten37-dev/RepoShelf/security/advisories/new).

Include a concise impact description and reproduction steps using synthetic
values. Do not include real PATs, credentials, cookies, private source content,
internal hostnames, organization or project names, project IDs, usernames,
absolute personnel paths, or ownership-marker contents. If sensitive evidence
is essential, first request a secure exchange method in the private report.

You should receive an acknowledgement within seven days. Validation, disclosure,
and remediation timelines depend on severity and maintainer availability. Please
allow a reasonable remediation window before public disclosure.

## Security boundaries

RepoShelf handles API credentials, remote content, native Git processes, and
managed local workspaces. Changes involving authentication, URL validation,
process execution, filesystem containment, ownership markers, or deletion need
explicit tests and security review. See the
[threat model](./docs/phase-0/SECURITY-THREAT-MODEL.md).
