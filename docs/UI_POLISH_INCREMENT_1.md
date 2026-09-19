# UI polish increment 1

This increment gives Randori's highest-frequency shell a cohesive, accessible visual foundation without changing authentication, pairing, or persistence behavior. It covers the anonymous landing page, account entry, primary navigation, and dashboard hierarchy. Existing selectors and deep-link behavior remain intact so later screens can adopt the same system incrementally.

## Design direction

Randori should feel focused and collaborative rather than like an administrative dashboard. The visual language uses a dark-first neutral canvas, a warm green primary action, a periwinkle focus indicator, restrained elevation, and generous spacing. The landing page now establishes one clear product promise and action hierarchy; supporting product proof is grouped into a quieter second column.

The small token layer in `index.html` owns:

- four neutral surfaces for page, elevated cards, controls, and selected states;
- three text levels that meet WCAG AA contrast on their intended surfaces;
- one green action color, one periwinkle keyboard-focus color, and distinct warning/error colors;
- shared radii, shadows, maximum content width, spacing, and sticky-header height.

## Responsive behavior

- Above 840px, the landing hero uses a two-column story/proof layout.
- Below 840px, the hero becomes a single readable column.
- Below 700px, primary navigation becomes a horizontally scrollable, single-line control instead of wrapping unpredictably; touch targets are at least 44px.
- Below 520px, landing actions and dashboard metrics stack, partner cards simplify, and authentication becomes a bottom sheet with safe-area padding.
- Header copy collapses before controls do, while account names truncate instead of causing horizontal overflow.

## Accessibility choices

- A keyboard-visible skip link targets the main landmark.
- The application shell now exposes header, navigation, and main landmarks.
- Navigation buttons retain their existing selectors and behavior while an observer mirrors the active class to `aria-current="page"`.
- The account control is a native button with expanded/controls state, Arrow Down entry, Escape dismissal, and focus restoration.
- All interactive controls receive a high-contrast `:focus-visible` ring. Form focus treatment no longer depends on a dark-only hard-coded background.
- Muted dark and light theme colors were raised to AA text contrast.
- Error text has a dedicated light-theme value that remains AA against its tinted status surface.
- The color-theme control names its next action, so its accessible name stays synchronized with the visible state.
- The pairing countdown bar exposes progress toward the weekly run and keeps both its numeric value and human-readable countdown synchronized.
- Reduced-motion preferences collapse decorative animation and smooth scrolling.
- Auth status and error regions remain live regions, with clearer visual grouping that does not rely on color alone.

## Deliberate trade-offs

- This is a CSS-first increment. It does not replace the single-file frontend or introduce a component framework, which would add migration risk before the product workflows settle.
- It avoids pixel-perfect screenshot assertions. Browser coverage checks semantic landmarks, focus, contrast, touch sizing, responsive stacking, and overflow—the durable user outcomes.
- Pair-room, editor, whiteboard, invitation, and profile controls inherit the shared tokens and focus rules, but their page-specific redesign is deferred to later issue #47 increments.
- The existing dark/light toggle remains; both palettes are tested rather than treating the light theme as a secondary path.

## Follow-up increments

1. Consolidate recurring inline card, status, field, and section-heading styles into reusable classes.
2. Refresh pairing, scheduling, and pair-room information architecture using the same tokens.
3. Standardize loading, empty, stale, denied, offline, and retry patterns.
4. Add a cross-browser accessibility audit job and stable visual baselines after the layout vocabulary settles.
