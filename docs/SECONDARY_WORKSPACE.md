# Secondary circle workspace (issue #438)

`SECONDARY_CIRCLE_WORKSPACE_ENABLED` defaults to `false`. Its prerequisites are
the membership, control plane, availability and secondary coordination flags.
Secondary scheduling is independently enabled; an unscheduled room remains a
workspace. AI, progress, statistics and unscoped operations retain their existing
`circle_feature_unavailable` boundary for members of multiple circles.

## Production go-live (2026-11-04)

`SECONDARY_CIRCLE_WORKSPACE_ENABLED=true` is live in production (owner,
2026-11-04). The owner confirmed **"Done" in chat** after setting the flag in
Vercel Production, following application of v25 and green production readiness.
The owner's confirmation is the source for the flag state; Vercel settings were
not read for this documentation update.

The post-flip read-only
[`GET /api/health/ready`](https://randoricircle.com/api/health/ready) check on
2026-11-04 returned HTTP **200** with `{"ok":true,"status":"ready"}`.
Readiness supports the completed schema cutover; it does not report individual
flag values.

## Owner cutover

Migration v25, `circle-owned-workspace`, is **breaking** because completion guards
are installed on existing secondary tables. The v16 ownership index already
supports the workspace keys. The code merge required owner application of v25
to restore readiness; that production cutover is complete, as recorded above.
Production application is a separate
owner operation using the protected migration workflow, its backup and restore
rehearsal, one-version apply and subsequent status inspection.

Main's additive v24, `account-deletion-email-tokens` (#451), is unchanged.
Its executable checksum remains
`bd19855cc6e4bcdd9fd942c7fc0adee23fb482331ccd1b9668096fe8f52cabdd`.
The local migration regression applies v24, then v25, checks that v24's ledger
row and schema are unchanged, and verifies workspace and pairing readiness.

For a future cutover rehearsal, use staging with two circles and a non-member.
Verify both directions of foreign-room rejection, scoped History, pair and solo
completion, document/run integrity, switching and independent retention. For
future cutovers, enable the flag only after that canary. The flag is now enabled
in production per the owner's confirmation above.
Turning it off restores the unavailable gates;
keep the new tables and rows, and never clear archive markers as rollback.

## Scope and responses

The live `auth_session_circle_contexts` selection is the sole scope authority.
Context headers are version fences. Requests repeat membership, publication,
eligibility, group and context checks in their SQL statements. Secondary room IDs
are `circle_<id>_publication_<id>_group_<id>`; primary rooms retain
`week_<week>_pair_<group>`. Numeric IDs from the two sequences never alias.

History contains only the selected circle, with `{public_id, name, is_primary}`
on every row. Home uses the same rows and presentation. Room and recap attribution
comes from an authorized response. A switch aborts the old workspace requests and
discards their delayed responses, editor state and private caches.

Foreign and nonexistent rooms return the same `404 {error:"pair not found"}`.
The approved primary code-document carve-out preserves
`404 {ok:false,error:"code document not found"}` for an authorized primary user's
own unsupported or missing document. It does not expose a foreign room.

Secondary pair completion requires both humans; solo completion requires its one
human. Completion HMACs and run attestations bind the secondary circle and group.
Completion receipts freeze the group and eligibility snapshots through declared
triggers. Secondary solo does not confer AI access. Documents and shared role and
timer controls remain restricted to two humans.

## Parallel chat retention

Secondary first-chat registration uses `circle_chat_retention_scopes`, keyed by
`(circle_id, group_id)` with the publication and complete circle scope chain.
The legacy `chat_retention_scopes` registry and its global `UNIQUE(pair_group_id)`
remain unchanged. Both sequences may contain the same numeric group ID.

The protected Chat retention workflow selects **primary** storage by default.
Select **secondary** to use the parallel control, scopes, runs, legal holds and
audit tables. The local CLI equivalent is `npm run chat:retention --
--secondary-workspace`. In that mode, the existing operator `WEEK_ID` input means
the secondary publication ID, and `PAIR_GROUP_ID` means the secondary group ID.
Scope/circle bindings, evidence, legal holds, generations, leases, bounded batches,
dry-run/purge and count-only output retain the existing retention protocol.
The two table families have independent worker state and never purge each other's
messages. Disabling workspace access does not discard retention ownership.

No request path creates tables, rewrites legacy tables or copies secondary rows
into legacy workspace tables. No circle names, room IDs, participant names,
messages or code are included in workspace telemetry.

## Account lifecycle

Account deletion redacts secondary chat, deletes solo runs and solo snapshots,
removes the member's meeting links and clears unattested shared run code. Shared
attested documents, receipt snapshots and retention ownership remain available
to partners with the existing expiry policy. Account export includes the member's
own secondary messages, runs and receipts plus visible controls and meeting links;
joint documents, signalling and the operational retention registry are excluded
with explicit reasons.
