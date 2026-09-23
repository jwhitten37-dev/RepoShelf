# Phase 6A: Remote Branch Write Gate

## Scope

Phase 6A permits one remote mutation: creating a GitLab branch through
`POST /projects/:id/repository/branches`. It does not update, rename, protect,
unprotect, merge, or delete refs. Existing catalog and repository browsing remain
GET-only.

## Assets and trust boundaries

- The authenticated PAT and configured GitLab API origin.
- Existing remote refs and immutable commit history.
- The selected source branch and its resolved full commit SHA.
- The user-entered target branch name.
- GitLab authorization and protected-branch policy.
- The boundary between a transport response and actual remote state.

## Required controls

1. Creation is available only as an explicit no-match action in the branch
   picker and requires a modal confirmation naming project, target, source ref,
   and abbreviated source SHA.
2. The source ref is resolved before confirmation and the POST uses its exact
   40-character commit SHA, never a moving branch name.
3. The target name is validated as a Git branch ref and queried exactly
   immediately before POST. Existing targets block creation; RepoShelf never
   overwrites or force-updates a ref.
4. The authenticated JSON POST is sent once. It receives no automatic retry and
   no redirect replay. Credentials remain subject to the existing exact-origin
   and API-path boundary. Phase 6 transient retry policy applies only to GET and
   cannot replay this POST.
5. Authentication, authorization, not-found, and deterministic client-response
   errors are reported without pretending success.
6. Timeout, cancellation after dispatch, network failure, rate limiting, server
   failure, or an unexpected redirect may be ambiguous. RepoShelf performs one
   exact GET reconciliation and never repeats the write automatically.
7. Reconciliation reports **created state confirmed; original response
   uncertain** only when the target exists at the exact requested source SHA. A
   different SHA is a collision. Missing or unreadable state remains uncertain.
8. Branch names, source SHA, project ID/path, and bounded status categories may
   be displayed. PATs, authorization headers, raw response bodies, cookies, and
   unbounded provider errors are never logged or shown.

## Required automated evidence

- POST uses JSON, the PAT header, manual redirect mode, exact configured API
  origin/path, cancellation, and timeout behavior.
- POST redirects are not followed and the write is never automatically retried.
- Exact preflight collision blocks POST.
- Successful response parsing requires an exact branch name and full commit SHA.
- Ambiguous failure reconciliation covers matching SHA, different SHA, missing
  branch, and failed reconciliation.
- Authorization, protected-branch, malformed-response, race, cancellation, and
  duplicate-action cases fail conservatively.
- UI contribution tests prove creation is explicit, confirmed, and reachable
  only from the no-match branch-search state.

## Manual corporate gate

Using a disposable project and branch namespace, validate PAT scope, SSO policy,
maintainer/developer permissions, protected branch naming rules, duplicate-name
races, timeout/network interruption, and audit-log attribution. Do not test with
production branch names. Record only sanitized outcomes and artifact provenance.
