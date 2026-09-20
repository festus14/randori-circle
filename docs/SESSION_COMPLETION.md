# Participant-confirmed session completion

## Product contract

Randori records a practice session as completed only when every distinct authenticated human in the immutable primary-pair snapshot has confirmed. A two-person pair needs two receipts, a triad needs three, and an AI pairing needs its one human receipt. Chat, scheduling, workspace edits, code runs, video state, and browser storage are not attendance evidence.

`GET /api/session-completion?room_id=week_<week>_pair_<group>` returns the authorized viewer's aggregate state. `POST /api/session-completion` accepts exactly `{room_id, action, base_version}`, where `action` is `confirm` or `withdraw`. Actor identity always comes from the authenticated session. Missing rooms, legacy-source identity collisions, and rooms outside the viewer's pair all return the same `404` response.

The response exposes only:

- `state`: `not_recorded`, `awaiting_participants`, or `completed`;
- whether the viewer has confirmed;
- aggregate confirmed and required counts;
- an opaque state version;
- the shared completion timestamp after unanimity.

It never returns participant identifiers or individual receipt timestamps. Confirmation is idempotent. A participant may withdraw while the aggregate is still awaiting participants. Once unanimity is observed in a write transaction, the receipt set is terminal and withdrawal returns a stable conflict. Mutations compare the opaque version inside the serialized write transaction and obtain their timestamp from that database transaction.

The version is a domain-separated HMAC under the server signing secret. It
binds the pair snapshot and receipt set without making individual confirmation
times recoverable from a bounded timestamp search.

## Storage and retention

Migration 17 adds `session_completion_receipts`, keyed by `(week_id, pair_group_id, user_id)`. Composite foreign keys bind the stored pair-member snapshot to the pairing group and bind the actor to an `auth`-source weekly participant. Migration-owned, schema-inspected triggers additionally compare the nullable third slot with NULL-safe equality, reject receipt updates, and freeze the group's member/AI shape plus every member's participant-source row after the first receipt. A table check requires the actor to occupy one of those exact pair slots, so another authenticated participant from the same week cannot forge a receipt and a pair cannot later become a triad or silently gain or lose quorum. No request performs DDL. The table stores no notes, answers, message content, workspace content, or provider data.

Receipts are retained with pairing history so completion metrics remain explainable. Explicit pair deletion cascades its receipts. Demo reset explicitly removes receipts for demo weeks before removing participants and groups. Participant or account deletion is otherwise restricted while retained receipts exist; future account-erasure work must define an auditable pseudonymization or paired-history deletion policy instead of silently corrupting completion totals. Historical pairings with no receipts are labelled “Completion not recorded,” never incomplete or no-show.

## Read models

History and recap add the same aggregate completion projection and completion badge. Public `total_sessions` and authenticated `your_sessions` count only unanimous receipt sets in non-demo pairings. `total_pairs` and `your_pairings` remain separate assignment counts. Secondary coordination-only pairings do not receive a workspace or completion capability.

Browser responses are fenced by request generation, authenticated account, canonical room, active circle public ID and context version, and the current room/cycle token. Sign-out, room change, circle change, workspace deactivation, or a delayed older response cannot update the wrap-up control.

While a non-terminal workspace remains visible, bounded polling refreshes the
aggregate so one participant observes the other participants' confirmations.
Polling stops on completion, hide, sign-out, or any scope reset.

## Rollout

1. Rehearse migration 17 against a disposable restore and verify exact v16 evidence.
2. Deploy the v17-aware runtime. Until migration 17 is applied, completion, history, recap, and stats fail closed rather than inventing zero sessions; pairing, auth, scheduling, and workspace remain available.
3. Run a fresh protected production status operation and apply only migration 17 using the existing one-version approval workflow.
4. Canary a pair, triad, and AI assignment across two browsers. Verify stale CAS, pre-terminal withdrawal, terminal completion, restart recovery, history/recap badges, and truthful stats.
5. Monitor generic endpoint error rates and aggregate completed-session counts. Do not log room, pair, account, or receipt identifiers.

Migration 17 is additive but changes the repository's exact schema contract. After it is applied, rollback must retain the v17 schema manifest and receipt table. Disable or revert the UI and request handlers while preserving read-compatible migration metadata, then roll forward with a fix. Do not drop receipts or rewrite the migration ledger.

## Alternatives considered

| Option | Benefit | Rejected because |
| --- | --- | --- |
| Infer completion from activity | No new write control | Produces false attendance from chat, runs, or idle workspaces |
| Let one participant complete the pair | Minimal interaction | Lets one person assert completion for everyone |
| Store a mutable group `completed` flag | Fast reads | Creates a second truth source that can diverge from receipts |
| Rely on nullable composite foreign keys alone | Fewer schema objects | SQLite skips a composite foreign key when the third-slot child value is NULL, so it cannot pin pair-versus-triad shape |
| Normalize the third slot with a sentinel column | Could use only foreign keys | Requires changing the pre-existing pairing table rather than keeping migration 17 additive |
| Add cancelled/no-show/dispute states now | Richer lifecycle | Requires attendance policy and adjudication outside this increment |
| Build provider-backed sessions first | Long-term media/session model | Adds provider coupling before the core trust contract is proven |
