# Phase 4.1 Threat and Recovery Review

This review supplements the Phase 0 threat model. The invariant for every row is
that uncertainty retains local data; only verified filesystem absence permits
registry cleanup.

| Scenario                               | Required detection/control                                                                   | Recovery result                                        |
| -------------------------------------- | -------------------------------------------------------------------------------------------- | ------------------------------------------------------ |
| Forged or edited request               | Strict schema, complete identity binding, marker/registry/Git/remote revalidation            | Poison operation; retain checkout                      |
| Replayed request or nonce              | Create-once operation, unique nonce, one non-terminal operation per workspace, atomic claim  | Reject replay; require fresh confirmation              |
| Two catalog coordinators               | Atomic non-stealable claim directory                                                         | One claimant; loser observes                           |
| Coordinator and fallback race          | Same atomic claim primitive and operation                                                    | One claimant; loser observes                           |
| Claimant crash before delete           | Claim is not stolen                                                                          | Retain; fresh confirmation/new operation               |
| Crash during delete                    | No second claimant; inspect path and marker on recovery                                      | Preserve/reconstruct registry unless absence is proven |
| Crash after verified absence           | Reconciliation may remove only matching stale registry entry                                 | Repair metadata; never delete another path             |
| Managed window fails to close          | No valid detachment acknowledgement                                                          | Retain; report handoff blocked                         |
| Dirty buffer in managed host           | Pre-detach buffer check; bound request and acknowledgement                                   | Block request or retain                                |
| Another window opens checkout          | Conflicting session evidence blocks; fresh checks and OS removal may also fail               | Retain on any ambiguity/open handle                    |
| Lease expires or heartbeat stops       | Treat only as liveness evidence                                                              | Notify/reconcile; never authorize deletion             |
| Sleep or clock jumps                   | Monotonic scheduling, conservative wall-time validation, anomaly bounds                      | Re-establish session or expire request; retain         |
| Journal symlink/junction/reparse       | No-follow component checks under extension storage                                           | Disable coordination; use safe fallback                |
| Torn/partial/oversized record          | Same-directory publication, strict size/schema limits                                        | Ignore temporary; poison published invalid state       |
| Unknown schema or mixed versions       | Version gate and environment/extension metadata                                              | Retain; fallback or fresh retry                        |
| Workspace/path substitution            | Bind workspace, clone root, canonical path, repository, project, branch, and HEAD everywhere | Poison operation; retain                               |
| Registry lost-update race              | Serialize mutation or rebuild from markers; remove by exact identity only                    | Reconcile without deletion                             |
| Push succeeds, handoff fails           | Push is not deletion authority                                                               | Retain pushed checkout; allow fresh assessment         |
| Network fails during revalidation      | Remote proof is mandatory where required                                                     | Retain; retry later                                    |
| Unknown ignored content                | Inventory and conservative classification                                                    | Block pending explicit review                          |
| Build watcher, shell, or open handle   | Do not kill processes; bounded no-follow removal                                             | Retain and show sanitized diagnostic                   |
| Checkout moved/replaced/linked         | Fresh canonical and no-follow checks                                                         | Block; retain registry evidence                        |
| Delete succeeds, catalog refresh fails | Separate deletion, registry, and refresh outcomes                                            | Report local release complete; retry refresh           |
| Journal cleanup race                   | Compact only validated terminal metadata; no checkout path deletion                          | Rebuild metadata as needed                             |
| Denial-of-service journal contents     | Bound files, bytes, depth, entries, and scan work                                            | Quarantine/skip safely; retain checkout                |

## Residual limitations

- VS Code does not expose unsaved buffers from every independent window to one
  extension host. The protocol therefore uses a managed-host pre-detach check and
  restarted-host acknowledgement, then fails closed on conflicting session
  evidence. Documentation and UI must not describe this as omniscient inspection.
- Process liveness and wall-clock time are not trustworthy deletion signals.
- Portable Node filesystem APIs do not support safe stale-claim takeover on all
  supported Windows filesystems. Automatic claim stealing is prohibited.
- A local user who can modify both extension storage and the managed repository
  can forge coordination evidence. Such evidence still cannot bypass fresh
  ownership, path, Git, remote, and capability checks; OS-level hostile-user
  isolation is outside this extension's boundary.
- Filesystem deletion cannot be transactional. Partial failure remains possible,
  so registry evidence is retained until absence is verified.

These limitations are acceptance constraints, not deferred bugs. Any proposal to
add claim stealing, unattended cleanup, process termination, or weaker ignored
content handling requires a new security review.
