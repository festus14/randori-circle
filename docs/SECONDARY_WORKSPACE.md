# Secondary circle workspace (issue #438)

`SECONDARY_CIRCLE_WORKSPACE_ENABLED` defaults to `false`. Its prerequisites are
the membership, control plane, availability and secondary coordination flags.
Secondary scheduling is independently enabled; an unscheduled room remains a
workspace. AI, progress, statistics and unscoped operations retain their existing
`circle_feature_unavailable` boundary for members of multiple circles.

## Owner cutover

Migration v24, `circle-owned-workspace`, is **breaking** because completion guards
are installed on the existing secondary pairing tables. Merging this code makes
readiness fail until the owner applies v24. Production application is a separate
owner operation using the protected migration workflow, its backup and restore
rehearsal, one-version apply and subsequent status inspection. This PR never
applies the production migration or enables the workspace flag.

After owner application, rehearse in staging with two circles and a non-member.
Verify both directions of foreign-room rejection, scoped History, pair and solo
completion, document/run integrity, switching and independent retention. Enable
the flag only after that canary. Turning it off restores the unavailable gates;
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
