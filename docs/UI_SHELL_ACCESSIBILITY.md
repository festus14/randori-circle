# Accessible shell release slice

This slice implements issue #122 as the first mergeable part of the broader UI
work in #47. It deliberately changes presentation and interaction semantics,
not authentication, roster, retention, catalogue authorization, pairing, or
active-circle ownership behavior.

## Included

- WCAG AA light/dark semantic colors, 3:1 form-control boundaries, visible
  keyboard focus, reduced motion, and a skip link with native header,
  navigation, and main landmarks.
- A keyboard account menu whose first focus target is the first visible enabled
  action, including Account security when that server capability is enabled.
- Responsive 320 px and 390 px shell/auth layouts, keyboard view navigation,
  accessible weekly progress, and explicit active-circle UI states.
- Truthful language for invitations, session links, email reminders, approved
  catalogue availability, retention boundaries, and authorization-gated
  external services.

## Explicitly deferred

- A component-framework or design-system rewrite.
- Static readiness badges or other states that are not backed by live data.
- Screen sharing, SMS delivery, or any exercise-source adapter.
- Any rewrite of auth, active-circle selection, roster, pairing, retention, or
  race-fencing behavior.

## Verification contract

Focused browser checks cover landmarks, keyboard menu order, reduced motion,
theme contrast, mobile overflow/auth layout, progress semantics, truthful copy,
startup navigation intent, and active-circle required/error/retry state. A
static contract prevents the removed
placeholder/deployment/SMS affordances and old claims from returning. Existing
coverage, syntax, catalogue, migration, and Chromium gates remain authoritative.

The decision and considered alternatives are recorded as ID-23 in
`docs/IMPLEMENTED_DECISIONS.md`.
