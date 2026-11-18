# Original interview kits

Status: implementation candidate for issue #469 (epic #460)

Owner: Randori Circle maintainers

Last reviewed: 2026-11-18

## Catalogue and tracks

Two role-oriented kits add eight original exercises. The catalogue now has
27 active exercises and one retained retired record. Each kit also curates
three existing exercises without changing their statements, versions or hashes.

| Track / kit | New Easy | New Medium | New Hard | Existing members |
| --- | --- | --- | --- | --- |
| Backend / Backend data processing | Delivery Receipt Ledger | Shard Window Audit; Retry Credit Rounds | Shard Fence Planner | Message Frequency Leaders; Release Feed Merge; Resilient Network Budget |
| Frontend / Frontend state logic | Panel Notice Counters; Draft Revision Fold | Viewport Anchor Walk | Focus Shortcut Tour | Balanced Template Markers; Command Prefix Census; Command Message Segmentation |

Every new exercise has two public examples, JavaScript and Python starters,
eight fresh server-owned cases (including deterministic boundaries and an
upper-bound case), a JavaScript oracle, and an independently written Python
reference. `npm run validate:catalog` executes those references in **both**
production harnesses against generated cases and public examples. It needs
Node 24 and `python3`, not a configured provider or network access. The two CI
jobs that run it provision Python 3.14 using a SHA-pinned `actions/setup-python`;
a missing local Python installation produces a direct setup instruction. Unit tests
also compare small cases against separate brute-force references. The JavaScript
arm proves that the server oracle executes in the real VM harness, not that it
is correct independently; answer agreement with the separately authored Python
reference and small-input checks is the correctness evidence.

### Scheduling and difficulty review

Retry Credit Rounds has no job arrivals, durations or shortest-ready optimisation.
Its independently specified contract combines per-lane capped refill credits,
FIFO charges, a one-round cooldown, rotating ASCII lane visits and a global
round slot limit. Cases separately catch missing cooldown, uncapped balances,
fixed visit order, per-lane rather than global slots and shortest-charge queue
reordering. This replaces the initial scheduling draft before publication.

Draft Revision Fold is **Easy**: its full-update, strict-revision/tombstone rule is
a one-pass reducer, not a Medium challenge. The frontend kit therefore has two
Easy, one Medium and one Hard addition. Delivery Receipt Ledger and Shard Window
Audit use behavioural pattern metadata rather than promising that hash maps,
prefix sums or binary search are required at their modest bounds. The oracles
may use those techniques, but any correct implementation within runner limits
is valid; algorithm choice is not graded.

All wording, scenarios, examples, starters, generated inputs and reference code
were authored for Randori Circle from general algorithm topics. No problem-bank
statement, name, example or hidden test was copied or paraphrased. No third-party
account, crawler, import, source adapter or provider call was used. This follows
[the content policy](CONTENT_POLICY.md) and
[the provenance contract](CATALOG_PROVENANCE.md).

## Selecting a kit question

In the room's **Problem** panel, choose **Track**, **Interview kit**, then an
optional difficulty, pattern, language or search. Kit names are searchable and
shown on exercise cards and statements. Track narrows the kit options; switching
tracks clears an incompatible kit. **Clear filters** restores every filter to
All and retains the current exercise where the existing picker does so.

Click a card or use the existing exercise dropdown to pick a question. This is
the same versioned question selection, draft and workspace-sync path as before.
Filtering does not overwrite a hydrated shared-room question: an off-filter
current question remains pinned until a member explicitly picks another one.
Kits do not add a random assignment API or change who may select a question.
Interviewer-enforced ownership is a separate future increment; the role/timer
controls from ID-95 are unchanged.

## Data contract

The stable `data/randori-catalog-v1.json` filename now contains catalogue
`schemaVersion: 2`, with a top-level `kits` array. The validator still understands
schema 1 without kits. Catalogue identity and exercise `slug@version` identities
are unchanged. There is no database schema change or request-path DDL.

A kit contains exactly `id`, `title`, `track`, `description`, and `exerciseKeys`.
IDs and tracks are bounded kebab-case values other than the reserved filter
value `all`. Titles/descriptions are bounded plain single-line text. Membership
is a unique list of exact existing keys such as `shard-window-audit@1`; unversioned,
unknown, duplicate and extra fields fail validation. Maximums are 16 kits and
100 members per kit. Member order is editorial; filtering preserves normal
catalogue order rather than silently reordering the picker.

List/detail public projections derive `kits: [{id, title, track}]` for each
**active exact exercise version**. They do not expose the membership inventory,
generators, oracle source, evaluated cases, expected outputs, private evidence
or takedown metadata. Browser options derive only from the active projections,
so a kit with no active members disappears from the filter options.

Provenance remains schema 1: the original canonical exercise fields have not
changed. Editorial grouping is not exercise content and is excluded from
exercise hashes; re-curating a kit cannot rewrite existing content evidence.
New records use `original`, author `Randori Circle project contributors`,
`LicenseRef-Randori-Original`, review date 2026-11-18 and expiry 2027-11-18.
This is a bounded review window, not an evergreen approval.

## Authoring another kit or question

1. Read the content policy and provenance procedure first. Write the scenario,
   statement, examples, starters and cases independently; do not rename or
   lightly paraphrase a known problem. Specify ordering, ties, duplicate handling,
   empty/impossible outcomes and numeric bounds explicitly.
2. Add a new stable `slug@version` to the catalogue, with both language signatures
   and starters, pattern tags and difficulty, and complete governance metadata.
   Material changes to an existing exercise need a new version and review.
3. Add its server-only generator and standalone oracle in
   `api/_catalog-interview-kits.js`. The standard suite has eight cases: pin
   important boundaries, retain fresh random ordinary cases, and make the final
   case seed-independent at the documented upper bound. Avoid retry loops that
   depend on random uniqueness. All values must be JSON-compatible and fit the
   runner request, per-result-line and total-response limits.
4. Add a Python reference in `scripts/catalog-interview-kit-references.mjs` and
   independent small-input checks in `tests/unit/interview-kits.test.mjs`.
   Python's production namespace has a limited builtin set and no imports;
   JavaScript runs in an isolated VM. A solution that works in a normal shell
   but requires unavailable imports is not sufficient.
5. Add exactly one provenance manifest record with the original attestation,
   exact repository reference, collective author, content-policy evidence,
   attribution, reviewedAt and a real expiry within 366 days. Perform the
   content review before recording approval. Calculate the hash with
   `canonicalExerciseHash` from `api/_catalog-provenance.js`; never hand-edit a
   digest or extend review dates merely to make validation green.
6. Create or update a kit's exact member keys. Keep an Easy/Medium/Hard spread
   and a coherent track. Existing reviewed members may be curated without
   rehashing their content. Exercise references and public projections must
   still respect retirement and review expiry.
7. Run `npm run validate:catalog`, focused catalogue/provenance/view/kit unit
   tests, and the catalogue and kit Playwright specs. Run the normal
   deployability, runtime-DDL, syntax, CRDT, byte-budget and docs checks without
   changing thresholds. Link new documentation from `docs/README.md` and add a
   collision-free decision-log entry for a new behaviour or data contract.

## Retiring kit content and takedown

Removing a key from a kit only changes curation: it **does not** retire that
exercise, which remains independently browsable and executable. Removing an
entire kit likewise leaves its questions active. To withdraw a question, use
the exercise lifecycle/provenance workflow instead.

For an urgent concern, dry-run one exact question:

```sh
npm run catalog:takedown -- \
  --slug shard-window-audit --version 1 \
  --reference issue-469-content-review --date 2026-11-18 \
  --reason "Content review pending." --dry-run
```

After reviewing the dry run, remove `--dry-run`, inspect the two-file diff,
validate and ship through the normal reviewed PR path. Use the actual event
date and a non-sensitive tracking reference, not disputed text or reporter data.
The operator writes revoked provenance first and retirement second, with locks
and digest checks. Interrupted updates remain fail-closed and are recoverable
by repeating the identical event, as described in the provenance runbook.

Keep kit membership pointing at retired versions for editorial/audit history;
validation permits this so a data-only emergency takedown never needs a third
file or a new hash. List, detail, trusted lookup and evaluation still omit/refuse
retired questions. Update membership explicitly if a separately reviewed new
version should replace one; never silently fall forward for stored room/run
references. Dormant generators/references may be removed in a reviewed cleanup.
Restoration is not an operator command and still needs evidence review.

Before an active record's `review.expiresAt`, repeat the content review and
record a bounded new expiry. Runtime operations recheck the UTC date even in
warm processes; expiry, tampering and revoked approval fail closed. Tests
exercise expiry on the new content and takedown of every new question while
preserving hashes, kit history and unaffected members.

## Rollout and recovery

Ship additively, unflagged, like catalogue pack v3 (ID-60): all filters default
to All, the existing picker remains, and no permissions, durable state, network
adapter, secrets or provider configuration change. See
[ID-97](IMPLEMENTED_DECISIONS.md#id-97-curate-original-interview-kits-as-versioned-catalogue-metadata).

For a UI regression, revert the filter/card changes while keeping validated
content and identities. For content correctness or provenance concerns, retire
only the affected exact versions through the workflow above. A full feature
rollback reverts catalogue metadata, new exercises and matching manifest/runtime
records together; never leave cross-file drift or reuse removed slugs for new
semantics. No Turso migration or production/provider operation is required.
