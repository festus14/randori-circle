# Original catalogue pack v3

Status: reviewed implementation candidate

Owner: Randori Circle maintainers

Last reviewed: 2026-09-19

## Outcome

Pack v3 adds nine independently authored, executable exercises without changing
or retiring any existing `slug@version`. The pack is deliberately balanced:

| Difficulty | Exercises | Primary patterns |
| --- | --- | --- |
| Easy | Mentor Level Widths; Threshold Pair Count; Command Prefix Census | trees, two pointers, tries |
| Medium | Release Feed Merge; Compatible Review Orders; Connectivity Checkpoints | heaps, backtracking, disjoint sets |
| Hard | Coaching Route Sums; Command Message Segmentation; Resilient Network Budget | tree queries, trie plus dynamic programming, minimum spanning forest |

Every active record has JavaScript and Python starters, two public examples,
versioned original-content metadata, an immutable canonical hash, and eight
fresh server-owned evaluation cases. The last case is seed-independent and
exercises the documented upper bound; earlier cases cover empty or singleton
inputs where valid, ties, duplicates, impossible outcomes, and randomized
ordinary inputs.

## Originality and licensing boundary

The wording, examples, starters, generators, and reference oracles were written
for this repository from general data-structure and algorithm concepts. No
personal account, LeetCode page, private endpoint, premium content, scraped
material, copied example, or third-party hidden test was accessed or used.

Each new `slug@1` has a one-to-one record in
`data/randori-catalog-provenance-v1.json`. Its `original` source points to the
exact repository record, uses `LicenseRef-Randori-Original`, binds the public
content with SHA-256, and expires on 2027-09-19. Runtime catalogue operations
continue to fail closed after review expiry or on manifest drift.

## Design choices

- Nine exercises keep the release reviewable while filling all six named gaps
  and providing a real Hard tier.
- Simple JSON arrays, strings, integers, and bounded objects keep both runtime
  languages equivalent and avoid custom serialization.
- Deterministic output rules cover ordering and ties. In particular, network
  proposals use cost then original position, and segmentation uses minimum
  token count then lexicographic token-list order.
- Reference oracles use bounded production-shaped algorithms: heap merge,
  union-find, binary lifting, trie traversal, and dynamic programming. Generated
  payloads remain under the runner request and response envelopes.
- Existing catalogue IDs, the retired historical record, API projections, and
  stored run identity remain unchanged. New records are additive only.

## Alternatives considered

- Crawling or slowly imitating a human on a premium interview platform was
  rejected because account access does not grant redistribution rights and
  creates terms, privacy, availability, and provenance risk.
- External links alone were rejected because they do not provide reliable
  in-product execution or server-owned evaluation.
- A large bulk import was rejected because it makes originality, oracle, and
  runtime review too broad. Smaller reviewed packs are easier to validate and
  roll back.
- One shared generic generator was rejected because pattern-specific boundary
  cases are needed to expose shortcut solutions and runtime regressions.

## Verification, rollout, and rollback

Unit tests validate exact metadata, the 3/3/3 split, boundary and scale cases,
independent randomized references, manifest hashes and expiry, API discovery,
and real JavaScript/Python execution through the server harness. Browser tests
exercise title/tag/type/difficulty discovery including the new Hard tier.

Release through the existing signed manifest and catalogue validation gate. No
database migration, feature flag, network adapter, or new secret is required.
After deployment, canary list/detail and one JavaScript and Python execution.

Rollback removes only these nine active catalogue records, their matching
runtime definitions, and their manifest records in one reviewed change.
Historical run identity remains readable because already-persisted runs retain
their exact slug and version; never reuse any removed slug for different
semantics. A rights or correctness concern uses the existing fail-closed
takedown workflow instead of bypassing validation.
