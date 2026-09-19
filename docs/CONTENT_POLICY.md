# Randori Circle Content Policy

Status: active

Owner: Randori Circle project maintainers

Last reviewed: 2026-09-18

## Purpose

Randori Circle ships interview exercises that the project is entitled to use. The default catalogue contains original material authored for this project. Content provenance is part of the product data, not an informal note.

The legacy `data/leetcode-seed.json` file is excluded from the default catalogue. Its presence does not authorise publication, execution, syncing, or remote ingestion. No production catalogue flow may sign in to, crawl, scrape, imitate human traffic to, or evade controls on a third-party platform. A future third-party adapter requires documented permission, terms review, explicit feature gating, rate limits, and a separate release review.

## Required record

Every exercise must have:

- a stable lowercase slug and positive integer version; historical versions may share the slug, but only one version may be active;
- an `active` or `retired` lifecycle state;
- an original public prompt, constraints, examples, and JavaScript and Python starters;
- a server-side case generator and reference oracle while active;
- a rights owner, a concrete provenance statement, a review date, and visible attribution;
- a one-to-one versioned manifest record containing constrained source type,
  author, license or authorization evidence, canonical content hash, reviewer,
  and a review expiry no more than 366 days after review;
- explicit retirement and takedown metadata, including null values when neither applies.

The catalogue validator is authoritative for the machine-readable schema. The
separate versioned provenance manifest and its operator procedure are documented
in [Catalogue provenance and takedown](CATALOG_PROVENANCE.md). New or changed
content must pass both cross-file validation and unit tests before merge.

## Originality and rights

Contributors may submit content they created themselves for Randori Circle or content for which they can document sufficient rights. Do not reproduce or lightly paraphrase prompts, examples, evaluation cases, editorial text, or starter code from interview platforms, books, courses, employers, or other problem banks.

General programming ideas are not exclusive, but each Randori exercise must have independently written framing, wording, examples, cases, and metadata. The provenance statement should identify whether the content is original or licensed. Licensed content must also link to the permission or licence record in its attribution metadata before it can become active.

Reviewers check both the content and its recorded provenance. A missing, vague, or unverifiable rights record blocks publication.

## Public and server-owned data

Public catalogue APIs return only an explicit projection of active exercises: identity, public content, language starters, and transparency metadata. They never serialize server-side evaluation-suite objects.

Evaluation cases are generated afresh by the server for each run using cryptographically backed randomness. Reference oracles compute expected values inside the application server. Clients select a slug and language, then send code; they may also pin the exact active version to detect stale editor state. They cannot supply tests, expected values, pass counts, or total counts. When a version is omitted, the server resolves the sole active version, runs its generated cases, compares returned values with its oracle results, and persists only the computed result.

Randori Circle is a public repository. Its generators, constraints, and reference oracles are inspectable and are not represented as secret or as exam-grade anti-cheating protection. Runtime randomisation prevents clients from choosing the evaluated inputs or forging pass and total counts; it does not make an open-source oracle unknowable.

The remote Piston runtime receives generated inputs and the submitted program, but never server-computed expected outputs. It returns candidate values to the application server, where comparison occurs. The application must not put complete generated suites or expected outputs in browser payloads, logs, analytics, exception context, run snapshots, or user-authored database fields.

## Content review checklist

Before activation, a reviewer verifies that:

1. the wording and examples are original or supported by a recorded licence;
2. the prompt is unambiguous for both supported languages;
3. constraints agree with examples and server cases;
4. entrypoint identifiers and starters match the server-side generator contract;
5. generated cases cover ordinary, boundary, empty where allowed, and intentionally broken implementations;
6. output ordering and equality rules are deterministic;
7. candidate solutions require no network access, third-party data, wall-clock timing, random source, or secrets;
8. the validator, unit tests, dependency audit, browser CI, preview deployment, and automated review pass.

Review dates use `YYYY-MM-DD`. Material prompt or semantic changes require a new version and another review. The prior version becomes retired before the replacement becomes active, so a slug has at most one active version. Typographical changes that cannot affect a solution may retain the version but still update the review date.

Catalogue lookups with an explicit version are exact and never fall forward. A lookup that omits the version resolves the slug's sole active version. Retired-only and unknown slugs resolve to no exercise.

## Retirement

Retirement is fail-closed:

- change the exercise and retirement metadata to `retired`;
- record the date, reason, and replacement slug when one exists;
- make its server-side generator unreachable immediately; an emergency
  data-only takedown may leave dormant code until a follow-up cleanup;
- exclude it from browsing, public detail, and execution immediately;
- retain only the minimum metadata needed to explain historical run references.

Historical results may keep slug/version and aggregate outcomes, but must not make a retired prompt or its cases executable. A replacement is a new stable catalogue record; it is never selected silently for an old version.

## Takedown workflow

Anyone can report a rights, privacy, safety, or accuracy concern to the repository maintainers. Use GitHub private vulnerability reporting when the report contains sensitive details; otherwise open a repository issue labelled `content-takedown`. Do not include third-party credentials, private correspondence, or disputed copyrighted material in a public issue.

Maintainers will:

1. acknowledge the report and assign a private or public tracking reference;
2. set takedown metadata and, when the concern is credible or urgent, retire the exercise immediately;
3. preserve only evidence needed to investigate ownership and provenance;
4. consult the contributor or rights owner without sharing reporter data unnecessarily;
5. remove, replace, or restore the content based on the review;
6. record the resolution and add regression coverage if a product control failed.

The bounded `npm run catalog:takedown -- ...` command is the emergency removal
path. It retires one exact `slug@version`, records the same non-sensitive
reference in catalogue and manifest, and is idempotent for that event. The
manifest is written first so an interrupted operation makes the runtime fail
closed. Restoration always requires a reviewed content change; there is no
one-command republish operation.

An exercise with a pending takedown may not be newly activated. Removal from public and execution APIs takes priority over preserving catalogue availability.

## Changes to this policy

Policy and catalogue changes use normal branch and pull-request review. Any relaxation of provenance, server-owned evaluation, retirement, or takedown controls requires an explicit security and rights review; it must not be introduced as an incidental implementation change.
