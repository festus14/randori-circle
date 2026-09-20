# GitHub Actions Node 24 runtime

Status: implemented compatibility increment; no application or provider change.

## Decision

All first-party GitHub Actions are pinned to reviewed immutable commits whose
published `action.yml` declares `runs.using: node24`:

| Action | Release | Immutable commit |
|---|---:|---|
| `actions/checkout` | `v7.0.1` | `3d3c42e5aac5ba805825da76410c181273ba90b1` |
| `actions/setup-node` | `v7.0.0` | `820762786026740c76f36085b0efc47a31fe5020` |
| `actions/upload-artifact` | `v7.0.1` | `043fb46d1a93c77aae656e7c1c64a875d1fc6a0a` |
| `actions/download-artifact` | `v8.0.1` | `3e5f45b2cfb9172054b4087a40e8e0b5a5461e7c` |

The versions and runtime declarations were verified from the official action
repositories on 2026-09-20. The repository test suite now scans every workflow
and rejects mutable tags, unknown first-party actions, older revisions, and a
missing approved action.

This increment changes only action runners. Workflow triggers, permissions,
protected environments, concurrency locks, secret placement, commands,
timeouts, cache inputs, artifact names, paths, retention, and failure policy
remain unchanged. The E2E checkout now explicitly disables credential
persistence; it never pushes repository changes and needs no Git credential.
The backup-control allowlists and exact workflow digests advance with the
reviewed bytes.

## Compatibility choice

`download-artifact@v8` fails on an artifact digest mismatch by default. Randori
keeps that stricter behavior: backup evidence must fail closed instead of being
consumed after an integrity warning. The upload workflows still produce normal
archives, so the new direct-file behavior in `upload-artifact@v7` is unused.
The ESM migration in the actions is internal to their bundled distributions and
does not change the workflow interface.

Using floating major tags would make future action code changes invisible to
review. Retaining Node 20 actions would rely on GitHub's temporary forced Node
24 compatibility path and preserve a known removal risk. Forking the actions
would transfer dependency and security maintenance to this project. Immutable
official Node 24 releases provide the smallest auditable upgrade.

## Validation and rollback

Run:

```bash
npm run check:backup-controls
npm run check:deployability
node --test tests/unit/github-actions-runtime.test.mjs
npm run test:coverage
```

The authoritative proof is a Linux Actions run in which checkout, Node setup,
coverage, Playwright installation, browser tests, and artifact upload complete
without the Node 20 forced-runtime annotation. Protected backup and migration
workflows remain subject to their existing environments and should not be
dispatched without their normal operational reason.

Rollback is a reviewed revert of this complete increment, including workflow
digests and allowlists. Do not roll back only the workflow files: that would
correctly fail the immutable backup-control contract.
