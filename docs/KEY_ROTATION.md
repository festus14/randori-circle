# Credential and identity key rotation

This runbook rotates four independent key rings without rewriting database rows:

| Purpose | Active key/version | Ordered prior keys | V2 write switch |
| --- | --- | --- | --- |
| Email activation | `EMAIL_VERIFICATION_ENCRYPTION_KEY` / `_KEY_VERSION` | `EMAIL_VERIFICATION_ENCRYPTION_PREVIOUS_KEYS` | `EMAIL_VERIFICATION_ENVELOPE_WRITE_VERSION` |
| Password reset | `PASSWORD_RESET_ENCRYPTION_KEY` / `_KEY_VERSION` | `PASSWORD_RESET_ENCRYPTION_PREVIOUS_KEYS` | `PASSWORD_RESET_ENVELOPE_WRITE_VERSION` |
| Invitation email | `INVITATION_EMAIL_ENCRYPTION_KEY` / `_KEY_VERSION` | `INVITATION_EMAIL_ENCRYPTION_PREVIOUS_KEYS` | `INVITATION_EMAIL_ENVELOPE_WRITE_VERSION` |
| Provider-email observation | `IDENTITY_EMAIL_HASH_KEY` / `_KEY_VERSION` | `IDENTITY_EMAIL_HASH_PREVIOUS_KEYS` | Always writes the active version |

Each prior-key value is a JSON array with at most three entries, newest first:

```text
[{"version":2,"key":"<32-byte-base64url>"},{"version":1,"key":"<32-byte-base64url>"}]
```

Versions and key material must be unique, prior versions must strictly decrease
and remain below the active version, and keys must be canonical 32-byte
base64url values. A central validation checks all configured active and prior
entries on every ring use and rejects key material reused between any two
purposes, including reuse between AES envelopes and the identity HMAC.
Configuration fails
closed when the ring is malformed, ambiguous, downgraded, or substitutes new
material at a version already present in an envelope or identity observation.
No production secret or key fingerprint belongs in source control, logs, issue
comments, screenshots, or retained rehearsal artifacts.

## Envelope and failure contract

Credential envelope v2 uses AES-256-GCM. Its clear header contains only envelope
version, numeric key version, and a one-way purpose-scoped key fingerprint.
Associated data binds the purpose, envelope version, key version, and exact
outbox idempotency key, so ciphertext cannot move between credential types or
events. Existing three-part v1 envelopes remain readable by trying the bounded
ring in order; v1 writes remain the default during the compatibility deployment.

Inactive, expired, revoked, consumed, or superseded credentials are suppressed
from authoritative hashes and sequence state before decryption wherever that
state is sufficient. An unknown/retired key, a future envelope/event version,
or a header fingerprint that disagrees with configured material is retryable,
because header tampering cannot be distinguished from a repairable deployment
substitution until authenticated decryption. A structurally malformed envelope
or an authenticated-body/ciphertext/tag/idempotency replay failure is terminal.
Because v1 has no key identifier, a well-formed v1 authentication failure is
conservatively retryable.

Rotation metrics contain only aggregate statuses, envelope/key versions, active
and prior version numbers, and readiness counts. They never return keys,
fingerprints, ciphertext, tokens, provider subjects, recipient addresses, or
event identifiers. Aggregate `ready` is an operator retirement gate, not a
global user-request gate: ordinary create, verify, consume, recent-auth, and
resend paths validate their schema and complete cross-purpose-safe configuration,
then validate only the credential they actually consume. An unrelated malformed,
dead-lettered, or unavailable-key event therefore stays visible to operations
without taking valid user flows offline.

Any actionable or explicitly retained legacy-v1 envelope makes `ready` false.
V1 identifies neither its sealing key nor its key version, so aggregate metrics
cannot prove that any configured key is safe to remove while such material
exists. This conservative retirement rule does not disable v1 delivery: readers
continue trying the bounded active/prior ring. Delivered or suppressed activation
and reset events are terminal and are not counted. Invitation delivery is
different because a live invitation can reuse its latest delivered credential;
that envelope remains retained until the invitation is used, revoked, expired,
loses its active owner, or reaches the five-send limit.

## Staged rotation

1. Back up production and complete the isolated restore rehearsal for the exact
   release commit. Keep all production mutation gates unchanged.
2. Deploy the compatibility reader with each existing credential key explicitly
   configured as version `1`, empty prior arrays, and all three write switches
   set to `1`. Confirm schema migration state is unchanged.
3. Rehearse v1 delivery, v2 delivery, retry for a missing old key, tamper
   rejection, resend, restart, and isolated restore. Retained evidence may
   contain only the aggregate rotation projection.
4. Set one credential purpose's write switch to `2`, without changing its key or
   version. Confirm new rows report v2 and existing v1 rows still deliver.
5. For that purpose only, generate a new key, increment the active version, and
   move the former version/material to the front of its prior array. Deploy the
   active key, version, and prior array atomically. Do not rotate another purpose
   until readiness is green.
6. Keep the old key while any actionable or retained v1 count remains; `ready`
   stays false until that count is zero because v1 cannot identify one safe
   retirement candidate. Also keep a prior key while any old-version count names it.
   Activation and reset must additionally pass their 30-minute token lifetime,
   lease/skew margin, retry window, and replayable dead letters. Invitation
   readiness also retains the latest delivered or suppressed envelope for every
   live invitation that has sends remaining, because resend decrypts that stored
   credential. Keep its key until the invitation is accepted, revoked, expired,
   or exhausts its five-send limit, and until no replayable dead letter depends
   on it; the invitation lifetime is seven days. Replay superseded actionable
   work so it can be authoritatively suppressed before retiring the key.
7. Identity rotation always hashes with the active version. Keep the prior key
   until old-version observation count reaches zero. With it, unchanged email is
   rekeyed and a genuine change remains a change. Removing it early deliberately
   chooses a neutral rebaseline: the next observation emits only
   `provider_email_rekeyed`, never a false change event. Record that emergency
   acceptance before removal.
8. Remove only a prior entry whose aggregate actionable/observation count is
   zero, then repeat the isolated restore/readiness rehearsal.

## Rollback

Once a higher key version or v2 envelope has been written, rollback is
forward-only: never lower an active key version and never replace material at an
existing version. If v2 writing causes an incident, keep the same active and
prior ring, return only that purpose's write switch to `1`, and deploy the
compatible reader while investigating. If a new active key causes an incident,
fix its configuration or deploy a still-v2-capable build with the same version;
do not make the former key active under a lower version. Re-add an accidentally
removed prior key at its original version to recover retryable work. For broader
integrity concerns, stop delivery and use the protected PITR workflow rather
than bulk-decrypting or rewriting queued payloads.
