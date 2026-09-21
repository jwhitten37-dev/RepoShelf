# Phase 4.1D Native Windows Adversarial Gate

Phase 4.1D is an acceptance exercise, not a new deletion path. Run it only with
disposable data on native Windows. A WSL result is not native-Windows evidence.
The gate is incomplete until every matrix row passes against the exact candidate
VSIX and commit.

## Candidate and environment

1. Run the **Windows native gate** workflow for the candidate commit. Retain its
   VSIX, SHA-256 file, environment report, and workflow URL.
2. Verify the downloaded VSIX hash, then install that exact file in VS Code.
3. Use a dedicated local NTFS clone root containing no non-test data and a
   disposable GitLab project with disposable branches.
4. Record VS Code, RepoShelf, Windows, Git, Node, filesystem, commit, VSIX hash,
   and evidence-root versions in the matrix below.
5. Use opaque fixture labels such as `ignored-secret-a`; do not put credentials,
   source text, ignored filenames, environment values, or raw journal records in
   evidence.

The workflow proves that the portable suite, junction-root checks, build, audit,
and packaging execute on a native Windows runner. It does not prove VS Code
window behavior, GitLab network behavior, Windows open-handle interference,
clock changes, or interactive recovery. Those rows require the installed VSIX.

## Evidence captured for every row

Before interference, record only sanitized values:

- matrix row, timestamp, candidate commit, and VSIX SHA-256;
- workspace ID, operation ID when present, project ID, and branch label;
- canonical checkout and clone-root labels (redact user/profile components);
- marker present/valid, registry entry present, checkout present, and local
  `HEAD` SHA;
- remote branch SHA and categorized ignored inventory counts; and
- unrelated workspace IDs and existence state for isolation checks.

After the action and again after a complete VS Code restart, capture the same
state plus the terminal outcome, diagnostic code, and sanitized RepoShelf log.
Never attach repository files, credentials, URL queries/userinfo, raw ignored
paths, raw journal bodies, or environment dumps.

## Required invariants

For a successful release:

- the exact checkout is absent and absence was verified;
- only its exact registry entry is absent;
- unrelated workspaces remain;
- the expected remote branch and commit remain; and
- a refresh failure, if induced, is reported separately from deletion.

For a blocked, failed, cancelled, expired, interrupted, or uncertain release:

- checkout, marker, local commits, untracked files, ignored fixtures, and
  registry recovery evidence remain;
- no unrelated workspace changes; and
- restart reconciliation does not delete the retained checkout.

Any ambiguity is a failure. Preserve the disposable fixture until the evidence
is reviewed; never force cleanup through RepoShelf.

## Adversarial matrix

Copy this table into a private test artifact and complete one row per attempt.
Evidence locations must be sanitized relative paths or controlled artifact URLs.

| ID  | Scenario and interference                                            | Expected result                                                            | Actual/result after restart | Evidence | Status  |
| --- | -------------------------------------------------------------------- | -------------------------------------------------------------------------- | --------------------------- | -------- | ------- |
| W01 | Original coordinator closes first; release from managed host         | Restart-safe fallback may complete only after fresh checks                 |                             |          | Not run |
| W02 | Close managed window clean without Release, then reopen              | All local state and registry entry retained                                |                             |          | Not run |
| W03 | Close managed window dirty without Release, then reopen              | Tracked, untracked, ignored, committed, and unsaved state retained         |                             |          | Not run |
| W04 | Reopen an existing retained workspace                                | Exact checkout reused; no replacement or deletion                          |                             |          | Not run |
| W05 | Push succeeds; handoff publication fails                             | Remote may advance; local checkout and recovery evidence retained          |                             |          | Not run |
| W06 | Push succeeds; managed-window closure fails                          | Remote may advance; local checkout and recovery evidence retained          |                             |          | Not run |
| W07 | Coordinator crashes before atomic claim                              | No claim authority; retained; fresh confirmation required                  |                             |          | Not run |
| W08 | Coordinator crashes after atomic claim                               | Claim not stolen; retained unless prior absence is proved                  |                             |          | Not run |
| W09 | Coordinator disappears; restart-safe fallback wins unclaimed request | One claimant; complete or safely retain                                    |                             |          | Not run |
| W10 | Duplicate coordinators race one operation                            | Exactly one claimant; loser observes                                       |                             |          | Not run |
| W11 | Duplicate/replayed request or nonce                                  | Replay rejected/poisoned; checkout retained                                |                             |          | Not run |
| W12 | Release multiple managed workspaces simultaneously                   | Per-workspace isolation; exact registry removals only                      |                             |          | Not run |
| W13 | Ignored `node_modules` and known generated content only              | Classification shown; release follows normal fresh checks                  |                             |          | Not run |
| W14 | Unclassified `.env`, database, key, and local-note fixtures          | Release blocked; fixtures and recovery evidence retained                   |                             |          | Not run |
| W15 | Long-open clean workspace; reminder, Keep Open, and snooze           | No unattended push/deletion; per-workspace reminder state                  |                             |          | Not run |
| W16 | Long-open dirty workspace; close while keeping local copy            | No unattended push/deletion; all local state retained                      |                             |          | Not run |
| W17 | Active shell rooted in checkout                                      | Do not terminate process; complete only if Windows removal safely succeeds |                             |          | Not run |
| W18 | Active package install/build watcher/dev server                      | Do not terminate process; removal failure retains registry evidence        |                             |          | Not run |
| W19 | File held open without delete sharing                                | Sanitized removal failure; local data and registry evidence retained       |                             |          | Not run |
| W20 | Network fails during coordinator revalidation                        | Release blocked/failed retained; retry requires fresh proof                |                             |          | Not run |
| W21 | Sleep beyond lease/request timing boundary                           | Liveness never authorizes deletion; expire or safely re-establish          |                             |          | Not run |
| W22 | Move wall clock backward, then forward across expiry                 | Clock anomaly/expiry retains checkout                                      |                             |          | Not run |
| W23 | Request expires before claim or final authorization                  | Expired request cannot mint/consume capability; retained                   |                             |          | Not run |
| W24 | Upgrade candidate between request and processing                     | Supported binding or fail-closed fresh retry; retained on mismatch         |                             |          | Not run |
| W25 | Move checkout away after confirmation                                | Canonical/ownership revalidation blocks; moved data retained               |                             |          | Not run |
| W26 | Replace checkout path with another directory/repository              | Identity/path/Git checks block; registry recovery evidence retained        |                             |          | Not run |
| W27 | Put clone root or checkout path through an NTFS junction             | No-follow/reparse check blocks; linked target is never deleted             |                             |          | Not run |
| W28 | Deletion succeeds, then catalog refresh fails                        | Local release remains complete; retry refresh never repeats deletion       |                             |          | Not run |

## Interference notes

- Use Process Explorer, PowerShell, or a minimal disposable helper to hold W19's
  file handle without delete sharing. Record the tool/version, not its full
  command line if paths contain profile data.
- Create W27 with `New-Item -ItemType Junction` and verify the target is outside
  the disposable checkout but still contains only disposable data. Test both a
  clone-root component and a substituted checkout component.
- Perform W22 only in an isolated VM with automatic time synchronization
  disabled. Restore synchronization immediately after the row.
- Induce W20 using an isolated firewall rule or test proxy scoped to the
  disposable GitLab endpoint. Do not capture tokens in proxy logs.
- For W28, disable only catalog metadata access after deletion authorization has
  completed. Confirm the completion UI says local release succeeded, then use
  its refresh retry and prove no second remove/registry-removal attempt occurred.

## Exit decision

Phase 4.1D passes only when:

1. the Windows workflow artifact matches the installed candidate;
2. every W01–W28 row is `Pass` with before, after, and post-restart evidence;
3. all failure paths retain data and registry recovery evidence unless exact
   absence was verified;
4. logs contain no credentials, sensitive ignored names, or repository content;
5. no unrelated workspace was removed or mutated; and
6. the completed matrix receives security/reviewer sign-off.

A skipped, flaky, ambiguous, or WSL-only row is not a pass.
