# Accessible shell release slice

The baseline in issue #122 established the accessible shell. Issue #192 builds
on that baseline after invite-gated signup, without cherry-picking the stale
#91/#98 prototypes. It deliberately changes presentation and interaction
semantics, not authentication, invitation, roster, retention, catalogue
authorization, pairing, notification-delivery, or active-circle protocols.

## Included

- Canonical semantic color aliases for canvas, surfaces, text, controls,
  focus, information, success, warning, and danger. The legacy component
  aliases resolve through them while the single-file UI is migrated.
- WCAG AA light/dark colors, 3:1 form-control boundaries, visible keyboard
  focus, reduced motion, forced-colors treatment, and a skip link with native
  header, navigation, and main landmarks.
- A keyboard account menu whose first focus target is the first visible enabled
  action, including Account security when that server capability is enabled.
  Escape returns focus; Tab and outside pointer interactions close without
  stealing the user's new focus.
- Stable `aria-controls`/`aria-labelledby` relationships for primary views.
- Responsive 320 px, 390 px, and 640 px shell/auth layouts, 44 px coarse-pointer
  targets, keyboard view navigation, accessible weekly progress, and explicit
  active-circle UI states.
- Truthful language for invitations, session links, email reminders, approved
  catalogue availability, retention boundaries, and authorization-gated
  external services. Landing summaries, browser-tab sync, and reminder
  preferences expose explicit loading/ready/saving/saved/local/error states.
  Reminder controls stay disabled until identity hydration resolves; account
  reads and writes apply only an explicit successful preference envelope whose
  positive `user_id` matches the captured account. A save revalidates identity
  before mutation so an intervening session change cannot update another user.

## Explicitly deferred

- A component-framework or design-system rewrite.
- Static readiness badges or other states that are not backed by live data.
- Screen sharing, SMS delivery, or any exercise-source adapter.
- Any rewrite of auth, active-circle selection, roster, pairing, retention, or
  race-fencing behavior.
- Claims that a reminder was delivered: the preference records intent only,
  while the dashboard action opens an explicitly labelled email draft.

## Verification contract

`@axe-core/playwright` 4.13.0 is exact-pinned as a development dependency. The
focused settled-state scans fail on every violation carrying the WCAG 2.0,
2.1, or 2.2 A/AA tags. They use no rule or node exclusions. Axe `incomplete`
results are attached as JSON for manual review because automation cannot decide
every contrast, content, or interaction question.

Targeted browser checks continue to cover landmarks, menu focus return,
reduced motion, forced colors, theme contrast, 320/390/640 reflow, coarse
pointer targets, progress semantics, truthful request outcomes, startup
navigation intent, and active-circle required/error/retry state. The 320 px
layout is also the WCAG reflow equivalent of a 640 px viewport at 200% zoom.
Linux CI attaches 390 px anonymous and signed-in screenshots to the Playwright
report; failures retain the existing trace and screenshot artifacts. A static
contract prevents undefined tokens, unlabelled view relationships, dependency
drift, blanket axe exclusions, and old unsupported claims from returning.
Existing coverage, syntax, catalogue, migration, and deployability gates remain
authoritative.

The baseline decision is ID-23 and this increment is ID-47 in
`docs/IMPLEMENTED_DECISIONS.md`.
