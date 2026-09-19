# Catalogue provenance and takedown

Status: implemented for the bundled original catalogue

Owner: Randori Circle maintainers

Last reviewed: 2026-09-19

## Shipping boundary

`data/randori-catalog-provenance-v1.json` is the auditable rights manifest for
`data/randori-catalog-v1.json`. Its checked-in JSON Schema is
`data/randori-catalog-provenance.schema.json`; the runtime validator applies
the stricter cross-file and date-dependent rules that JSON Schema cannot
express.

Every `slug@version` must have exactly one provenance record. The record binds:

- source type and a stable source reference;
- author or authoring collective;
- concrete license or written-authorization identifier and evidence;
- public attribution;
- a SHA-256 digest of canonical exercise content;
- approval, reviewer, review date, and expiry date;
- explicit takedown state and incident or issue reference.

The canonical hash covers slug, version, title, difficulty, type, tags, prompt,
constraints, examples, and language definitions. Object keys are sorted and
array order is retained. Lifecycle and governance fields are excluded so an
emergency takedown does not require rewriting the content digest.

An active exercise is rejected at module startup and in CI when its provenance
is absent, malformed, duplicated, tampered, unapproved, expired, or under
takedown. Unknown manifest records also fail. Retired records remain in the
manifest for audit history; expired or revoked retired content is never listed,
resolved, or executed. A dormant server-side generator may remain after an
emergency retirement, but runtime lookup is still gated by the active catalogue
record. This makes a data-only takedown possible without weakening execution
authorization.

The current manifest contains only project-original exercises. It contains no
LeetCode text or source reference. `data/leetcode-seed.json` remains legacy,
non-authoritative data and is not read by this catalogue path.

## Validation

Run:

```sh
npm run validate:catalog
```

The command validates the manifest, hashes, catalogue schema, review expiry,
runtime generator coverage, and the import-time runtime build. It is included
in the required Linux `e2e` workflow. A content change without a corresponding
review and hash update fails closed.

Review expiry is deliberate. Before `review.expiresAt`, a maintainer must repeat
the content-policy review, update `reviewedAt`, choose a new bounded expiry, and
recompute the canonical hash only when content changed. Never extend an expiry
solely to make CI green.

## Emergency takedown

Use an issue number or non-sensitive incident identifier. Do not place disputed
text, credentials, private correspondence, or reporter details in the command
or public issue.

First validate a dry run:

```sh
npm run catalog:takedown -- \
  --slug focus-block-rollup \
  --version 1 \
  --reference issue-117 \
  --date 2026-09-19 \
  --reason "Emergency rights review." \
  --dry-run
```

Then rerun without `--dry-run`, inspect the two-file diff, run the full test
suite, and ship through the normal PR path. The command accepts only one exact
slug and version, bounded single-line metadata, and a real calendar date. It is
idempotent for the same event and refuses to overwrite a different retirement
or takedown event.

The command writes the revoked manifest first and the retired catalogue second.
If interrupted between those renames, runtime validation sees active content
with revoked provenance and refuses to start. Rerunning the same command repairs
that safe partial state. A successful operation:

1. marks catalogue status and retirement status `retired`;
2. records date, reason, and no implicit replacement;
3. marks catalogue and manifest takedown state `revoked`;
4. keeps the canonical content and rights evidence for audit history.

Restoration is intentionally not automated. It requires evidence review, a new
content version when semantics changed, updated approval dates, tests, and a
normal reviewed PR. This prevents an operator command from silently republishing
disputed content.

## Adding authorized content later

The schema recognizes `open-license` and `written-authorization`, but that is
not permission to add a source adapter. Open content needs an HTTPS source and
license-evidence URL plus a concrete SPDX-style identifier. Written permission
needs a controlled repository evidence reference and a `LicenseRef-*`
identifier. Any adapter additionally needs terms review, explicit feature
gating, request limits, and its own release review.

Never authenticate to or automate a personal LeetCode account, reuse Premium
cookies, copy LeetCode problem text, simulate human traffic, evade anti-bot
controls, or treat account access as publication permission.

## Recovery

If validation fails unexpectedly, do not bypass the gate. Identify the first
reported manifest path, compare the content diff with the recorded source and
review evidence, and either correct the metadata or retire the content. Git
history is the recovery mechanism for an accidental operator edit. Do not
restore an earlier clear state when the latest change represents a real
takedown; resolve the tracked rights review first.
