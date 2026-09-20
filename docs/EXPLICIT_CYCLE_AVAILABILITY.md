# Explicit weekly availability decisions

Status: candidate client/onboarding increment for issue #221. No schema,
migration, environment, provider, or API protocol change.

## Decision

Randori keeps existing default-included pairing semantics, but presents them as
inherited state rather than a saved member choice. The active circle's upcoming
cycle card now has two explicit actions: **Available** and **Skip this cycle**.
Either action always sends the existing exact `{cycle_key, expected_version,
is_available}` mutation, even when its boolean equals the inherited value. A
successful response must return `source: "user"`; only that source completes
the availability onboarding step.

The UI distinguishes all three server sources:

| Source | Meaning in the UI | Pairing effect before a save |
| --- | --- | --- |
| `cycle_default` | No member choice is saved; the cycle includes the member by default. | Included |
| `legacy_bridge` | No cycle choice is saved; the first compatible cycle inherited the previous account setting. | Inherited boolean |
| `user` | The member explicitly saved Available or Skip for this exact cycle. | Saved boolean |

Default inclusion is a temporary product tradeoff: it keeps small early circles
pairable before reminder delivery is production-ready, while the truthful label
and one-action confirmation remove the false appearance of consent. The backend
already treats an equal-value CAS mutation as a real write, creating version 1
or advancing the saved decision version; the client no longer suppresses it.

## Navigation and request ownership

Profile setup, the dashboard availability badge, the incomplete checklist item,
and the tour use one navigation owner. It:

1. captures the authenticated account, authentication generation, and current
   active-circle context;
2. opens Pairing as explicit user intent and starts/coalesces the authoritative
   availability refresh;
3. accepts only the still-current account, circle/context generation, cycle key,
   decision version, source, and value;
4. yields for rendering, then scrolls to the card and focuses the action that
   matches the effective value.

A later tab choice, sign-out, circle switch, cycle rollover, replacement version,
or newer navigation generation cancels the pending focus. If the read fails, the
Pairing view retains its accessible live error and retry action. Saving disables
both choices, announces progress, retains the last authoritative value on a
generic failure, and replaces it with the server-returned state on stale CAS,
cutoff, or rollover conflicts. No optimistic value is treated as saved.

## Alternatives considered

| Option | Pros | Cons | Decision |
| --- | --- | --- | --- |
| Strict opt-in eligibility | Clearest consent; no inherited participation. | Can empty new/private-beta cycles before reminder delivery and operations are ready. | Defer until reminders and adoption telemetry are reliable. |
| Keep the checkbox | Compact and familiar for a durable preference. | Conflates effective inherited state with a saved cycle decision; confirming the displayed value requires a misleading toggle away and back. | Rejected. |
| Automatically persist inherited values on read | Removes the incomplete checklist immediately. | Turns viewing into consent, creates hidden writes, and defeats source truth. | Rejected. |
| Navigation-only repair | Small change and improves discovery. | Leaves the unsaved-as-saved contradiction and same-value confirmation bug. | Rejected. |
| Reminder email first | Helps members act before cutoff. | Depends on scheduled delivery, provider configuration, and production operations; it does not repair the in-app truth model. | Later increment. |
| Broad UI redesign | Could improve overall consistency. | Larger risk and slower delivery than repairing the highest-friction onboarding action. | Keep mid/low priority. |

## Rollout and recovery

Ship after session completion (#218) because both increments edit the dashboard
and onboarding surface. The change uses the existing availability tables and
endpoint, so deployment is code-only. Canary inherited true and false values,
same-value confirmation, explicit opt-out, stale CAS, cutoff rollover, active
circle switching, sign-out during a delayed request, and all four navigation
entry points. Monitor existing availability error telemetry; navigation logging
is aggregate and contains only the fixed entry-point name.

Rollback restores the prior client controls without changing saved decisions.
Any version-1 or later `source: "user"` records created through the explicit
actions remain authoritative and must not be deleted or converted back to an
inherited source.

## Verification

- `npm run check:syntax`
- `npm run check:runtime-ddl`
- `npm run check:deployability`
- `npm run test:coverage`
- `npx playwright test tests/e2e/availability-ui.spec.ts tests/e2e/onboarding-authority.spec.ts tests/e2e/ui-shell-accessibility.spec.ts`
