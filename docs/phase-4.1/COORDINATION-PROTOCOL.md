# Phase 4.1 Coordination Protocol

## Status and scope

This document is the Phase 4.1A implementation contract. Phase 4.1B must not
weaken it without another architecture and threat-model review.

The protocol coordinates independent VS Code extension hosts on one machine and
in one VS Code execution environment. It does not coordinate native Windows and
Remote–WSL, different user profiles, different machines, or different extension
installations. Filesystem and Git state remain authoritative. Protocol records
are untrusted coordination evidence and are never deletion capabilities.

## Storage and isolation

The journal root is `coordination-v1` below `ExtensionContext.globalStorageUri`.
The implementation must reject non-file global-storage URIs and fail back to the
reviewed Phase 4 restart-safe flow. It must create directories without links or
reparse points and use restrictive permissions where the platform supports them.

```text
coordination-v1/
├── sessions/<session-id>/descriptor.json
├── sessions/<session-id>/lease.json
├── workspaces/<workspace-id>/operations/<operation-id>/request.json
├── workspaces/<workspace-id>/operations/<operation-id>/detached.json
├── workspaces/<workspace-id>/operations/<operation-id>/claim/
│   └── claim.json
├── workspaces/<workspace-id>/operations/<operation-id>/outcome.json
└── quarantine/
```

Only validated UUIDs become path components. A record's workspace ID must equal
its workspace directory and its operation ID must equal its operation directory.
Records also bind the canonical local path and clone root as data, never as
journal path components. Operations for different workspace IDs share no mutable
files or claim directories.

`request.json`, `detached.json`, `claim/claim.json`, and `outcome.json` are
immutable create-once records. Writers serialize to a random same-directory
temporary file, flush and close it, then publish without replacement. Publication
fails if the destination already exists. Temporary files never count as records.
Directory durability is best effort because Node and Windows do not guarantee a
portable directory flush; missing records cause retention, not deletion.

`lease.json` is the sole replaceable record. It is written through a
same-directory temporary file and atomic rename. A torn, missing, malformed, or
unsupported record is treated as no valid lease. Journal readers cap file size,
object depth, string length, directory entries, and total operations scanned.
Unknown schema versions and unknown properties fail closed.

## Identities

All identifiers below are cryptographically random UUIDs generated independently:

- `workspaceId` identifies one materialized checkout and already exists in its
  marker and registry record.
- `operationId` identifies one explicit release attempt.
- `requestNonce` prevents substitution or replay across attempts.
- `coordinatorSessionId` identifies the catalog extension host that opened or
  adopted the workspace.
- `managedSessionId` identifies the managed-folder extension host.
- `detachedSessionId` identifies the empty host created after closing that folder.
- `claimantSessionId` identifies the only host permitted to process the request.

A session descriptor is immutable and contains schema version, session ID, role,
creation time, installation/environment fingerprint, extension version, and a
random boot nonce. The fingerprint distinguishes incompatible VS Code execution
environments without containing a username, hostname, or credential. It is not
an authentication secret.

## Record contract

Every record has `schemaVersion: 1`, `recordType`, and the complete binding needed
for its role. SHA values are lowercase full object IDs. Phase 4.1 initially
accepts 40-character SHA-1 repositories because that is the existing Git
contract; another schema is required for SHA-256 repositories.

### Release request

The managed host creates a release request only after the existing command has:

1. obtained explicit confirmation for the displayed project, branch, path, and
   operation kind;
2. checked associated unsaved buffers in that managed host;
3. completed normal release assessment or exact post-push verification; and
4. captured the expected local `HEAD`.

The immutable request contains:

```text
workspaceId, operationId, requestNonce, operationKind
instanceId, projectId, canonicalRepositoryUrl, targetBranch
canonicalLocalPath, canonicalCloneRoot, expectedHeadSha
coordinatorSessionId, managedSessionId
confirmationAt, createdAt, expiresAt
```

`operationKind` is `release` or `pushAndRelease`. The request lifetime is short
and bounded by implementation constants. A request grants permission to attempt
one release under the displayed confirmation; it does not grant permission to
delete and cannot relax any later check.

### Detachment acknowledgement

After publishing the request, the managed host invokes the existing close-folder
transition. The empty restarted host consumes a matching local restart intent and
publishes `detached.json`, binding all request identity fields plus
`detachedSessionId`, `detachedAt`, and the consumed intent ID. It publishes only
when the managed folder is no longer in that host's workspace and no associated
text document is dirty in that host.

This record is evidence that the requested VS Code transition occurred. It is
not proof that no other editor or process has the checkout open. A missing or
conflicting acknowledgement blocks coordinator processing and leaves the current
Phase 4 empty-host recovery path available.

### Session lease

An active host rewrites its lease periodically with its session ID, boot nonce,
role, monotonically increasing sequence, wall-clock observation, and expiration.
Within one process, monotonic time schedules renewal. Persisted expiry uses wall
time only as conservative liveness evidence.

- A backward clock jump, impossible duration, sequence regression, malformed
  timestamp, or excessive forward jump makes the lease indeterminate.
- Expiry or heartbeat loss may enable notification, fallback candidacy, or
  recovery inspection. It never authorizes deletion.
- Sleep may expire a lease. The waking host must establish a fresh lease and
  reconcile records before acting.

### Atomic claim

Claiming uses atomic creation of the operation's `claim` directory. The winner
then publishes `claim.json` inside it, binding every request identity,
`claimantSessionId`, claimant boot nonce, claim time, and claimant role. A claim
directory without one valid matching claim record is poisoned and blocks the
operation.

Claims are never stolen, replaced, or deleted because portable Node filesystem
APIs do not supply a reliable cross-process compare-and-swap for stale-lock
takeover on supported Windows filesystems. If a claimant crashes, that operation
ends in manual recovery: retain the checkout, mark the attempt interrupted when
possible, and require fresh user confirmation for a new operation ID and nonce.
This provides at-most-one claimant rather than unsafe automatic failover.

The preferred coordinator gets a short bounded opportunity to claim after
detachment. If no valid preferred-coordinator lease or claim appears, the detached
empty host may atomically claim the still-unclaimed request and execute the
restart-safe path. If either host loses the claim race, it becomes an observer.
The request must be unexpired at claim time. Claim processing then has a short,
bounded deadline scheduled from monotonic process time. Missing that deadline
blocks the operation; it does not transfer or steal the claim.

### Outcome

The claimant publishes exactly one immutable outcome:

- `completed`: filesystem absence was verified and registry reconciliation was
  attempted, with deletion and catalog-refresh results represented separately;
- `blocked`: safety or protocol validation failed before deletion;
- `failedRetained`: deletion did not start or did not establish absence; or
- `interrupted`: recovery found an abandoned attempt and cannot prove completion.

No outcome claiming deletion is accepted without fresh filesystem absence proof.
If absence is verified but registry removal or catalog refresh fails, the outcome
records `deleted` separately from those recoverable reconciliation failures.

## State machine

```text
no request
  → requested
  → detached
  → claimed by coordinator OR claimed by detached fallback
  → validating
  → blocked/failed-retained
     OR deleting → absence-verified → registry-reconciled → completed
```

Additional rules:

- Cancellation before a claim creates a terminal non-destructive outcome.
- Cancellation after a claim is observed by the sole claimant and retains data
  unless absence has already been established.
- Duplicate records with equal names are impossible by create-once publication;
  conflicting contents, unexpected files, or multiple apparent terminal states
  poison the operation.
- Only one non-terminal release operation may exist per workspace. Other
  workspaces remain independent.
- Request expiry before claim blocks the operation. A wall-clock anomaly or wall
  expiry after a timely claim does not suddenly authorize or interrupt deletion;
  the claimant must still finish within its monotonic processing deadline and
  obtain all fresh proofs and its bounded in-process capability.
- Journal state never changes the marker, registry, Git, filesystem, and remote
  checks required by the Phase 4 release service.

## Deletion authorization boundary

The claimant may mint the existing short-lived, in-memory, single-use deletion
capability only when all of these hold at the same decision point:

1. request, detachment, claim, session, schema, environment, expiry, nonce, and
   identity validation succeeds;
2. the request's explicit confirmation and managed-host unsaved-buffer proof are
   valid and bound to the acknowledged detachment;
3. no conflicting active managed session is known;
4. registry and ownership marker agree with every request identity;
5. fresh canonical containment and no-link/reparse checks succeed;
6. fresh Git operation, dirty, untracked, ignored-content, `HEAD`, branch, remote,
   reachability, and local-only-ref checks succeed;
7. the claimant has no associated dirty text document;
8. exact post-push remote proof succeeds when required; and
9. immediate pre-delete revalidation succeeds.

Items 2 and 3 are distributed safety evidence, not a claim that VS Code exposes
other windows' live buffers. Unknown or unclassified ignored content blocks the
operation. Open handles and external processes are not killed; bounded removal
failure retains registry recovery evidence.

## Registry and completion reconciliation

VS Code `globalState` remains an index and is not used as a message bus. Its
read-modify-write API is not a cross-host transaction, so Phase 4.1B must add a
filesystem-serialized registry mutation adapter or rebuild the registry from
validated markers after concurrent writes. A release must never remove another
workspace's record.

The safe ordering remains:

1. delete using an in-memory capability;
2. verify filesystem absence;
3. remove only the matching registry entry;
4. publish/reconcile completion; and
5. refresh only the affected catalog project and branch.

On activation, reconciliation inspects bounded journal records, registry entries,
markers, and filesystem existence. Ambiguity retains data. Verified absence may
repair stale registry state but must never cause deletion. Catalog refresh is
retryable metadata work and is never reported as a deletion failure.

## Retention, diagnostics, and upgrade

Active and ambiguous operations are never age-deleted. Completed, cancelled, and
blocked records may be compacted only after a bounded retention interval and only
after their outcome is validated. Cleanup removes journal metadata, not checkout
content. Quarantined malformed records are bounded and contain no source bytes.

Diagnostics include operation/workspace IDs, state, sanitized filesystem error
codes, and remediation. They redact credentials, URL userinfo/query values,
repository content, ignored filenames likely to be sensitive, environment data,
and raw record bodies.

An extension upgrade may read supported older schemas but writes only its current
schema. Unknown newer schemas disable coordinated processing for that workspace
and preserve the checkout. Downgrade, partial migration, and mixed extension
versions fail closed and offer the reviewed fallback or a freshly confirmed
retry; they never rewrite unknown records.

## Legacy fallback boundary

The Phase 4 `PendingReleaseStore` remains the fallback until this protocol has
passed Phase 4.1B/C gates. It is single-intent global state and must not be
mistaken for the multi-workspace journal. During migration, one release attempt
uses exactly one protocol: legacy restart-safe or coordination-v1, never both.
Phase 4.1B must test upgrade with a pending legacy intent before enabling the new
protocol by default.
