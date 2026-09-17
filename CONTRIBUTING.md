# Contributing to RepoShelf

Thank you for helping improve RepoShelf.

## Before you begin

- Read the [Code of Conduct](./CODE_OF_CONDUCT.md).
- Search existing issues and pull requests before opening a new one.
- Use a public issue only when it can be described without credentials, private
  source, internal URLs, organization names, project IDs, usernames, or managed
  workspace marker data.
- Report security concerns privately as described in [SECURITY.md](./SECURITY.md).
- Discuss large behavior, storage, authentication, provider, or safety changes
  before implementation.

## Development setup

RepoShelf uses Node.js 24, TypeScript, ESLint, Prettier, and Vitest.

```bash
npm ci
npm run check
npm run build
```

Automated materialization tests use disposable local Git repositories. They must
not require access to a real GitLab instance. Manual provider tests must use
authorized, non-production test resources and record only nonsensitive pass/fail
results.

## Pull requests

1. Create a focused branch from `main`.
2. Follow existing TypeScript conventions and preserve safety boundaries.
3. Add or update tests for behavior changes.
4. Update relevant documentation and `CHANGELOG.md`.
5. Run `npm run check`, `npm run build`, and `npm audit`.
6. Complete the pull request template without private environment details.

Pull requests must not commit dependencies, build output, coverage, VSIX files,
credentials, environment files, local VS Code settings, or managed workspaces.

Unless explicitly stated otherwise, contributions intentionally submitted for
inclusion are licensed under the Apache License 2.0, consistent with Section 5
of that license.
