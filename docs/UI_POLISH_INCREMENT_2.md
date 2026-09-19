# UI polish increment 2: weekly workspace

This increment extends the shared visual system from the application shell into the weekly practice journey: circle, pairing, dashboard scheduling and chat, code/video, exercise discovery, whiteboard, and history. It changes presentation and accessibility only. Authorization, server-owned evaluation, pair-room membership, scheduling concurrency, message delivery, workspace persistence, and catalogue provenance keep their existing contracts.

## Product flow and layout

The interface follows the order in which a private circle gets value:

1. confirm the people in the private circle;
2. review the current immutable pairing and upcoming availability;
3. agree a time and message the partner from the dashboard;
4. enter the authorised room to choose an exercise, code, optionally use video, and sketch on the shared board;
5. return to a server-backed pairing recap and recoverable workspace checkpoint.

On wide screens, closely related work shares space: scheduling and chat sit side by side, the catalogue sits beside the editor, and local/remote video tiles form one row. At 840px these become single-column work areas. At 700px navigation and the whiteboard toolbar scroll within their own containers. At 520px filters, video tiles, controls, and invitation forms stack so the page does not acquire horizontal overflow.

## Reusable UI vocabulary

- `view-head`, `eyebrow`, and `view-copy` establish one page-level heading and short orientation copy.
- `status-chip` communicates idle, progress, success, warning, and error states with text, shape, and color. It is used only for compact status, not as a control.
- `state-panel` separates empty, stale/warning, and error explanations from normal data. Retry actions remain adjacent native buttons.
- `surface-inset` and the existing card tokens group secondary material without introducing another elevation system.
- workspace toolbars use named groups and native pressed state. Keyboard focus continues to use the shared high-contrast ring from increment 1.

## Truthful controls and state handling

- The video surface says it is optional and does not request camera or microphone access until **Join video** is used. Camera and microphone buttons expose `aria-pressed`. The screen-share placeholder was removed because no screen-sharing capability exists.
- The code workspace describes the approved catalogue and server-owned evaluator. It does not claim that private evaluation cases are shown locally.
- The board describes completed-gesture, revisioned snapshot syncing; it does not imply live cursors or a CRDT.
- Circle, catalogue, chat, schedule, recap, and history loading/empty/error states are visually distinct. Failures do not substitute local/demo data for private server data.
- Catalogue failure keeps any already hydrated workspace visible and offers the existing retry action. A genuinely empty catalogue is labelled differently from a failed request.
- History failure exposes a **Retry history** action. Pair recap failure retains its own retry action and does not make an unavailable checkpoint appear recoverable.

## Accessibility and browser checks

- Every refreshed view has an explicit heading relationship.
- Video controls, editor controls, whiteboard tool groups, schedule status, chat status, and sync status have programmatic names or live status semantics.
- Whiteboard tool buttons reach 40px on desktop and 44px on narrow layouts; other narrow-screen primary actions inherit the 44px target floor.
- Dense whiteboard controls scroll horizontally inside the toolbar rather than widening the document.
- Browser tests assert semantic headings, regions, toolbar names, pressed state, responsive stacking, document overflow, truthful control absence, and recoverable error states. The complete suite remains on Chromium; a focused workspace smoke runs on Firefox and WebKit as well. These assertions intentionally avoid pixel snapshots.

## Alternatives considered

| Option | Advantages | Why it was not selected for this increment |
| --- | --- | --- |
| Rewrite the frontend in React/Next.js now | Clear component boundaries and stronger long-term test isolation | A framework cutover would mix product UI work with routing, auth, and state risks. Small reusable CSS/semantic patterns deliver value on the current runtime first. |
| Put scheduling, chat, video, code, and board on one always-visible canvas | Fewer navigation actions | Overloads small screens, weakens task focus, and makes the authenticated room boundary harder to understand. |
| Add optimistic screen share, live cursors, or disabled “coming soon” controls | Signals a broad roadmap | Controls that cannot complete their advertised action are deceptive. They should appear only with a real capability and an honest unavailable state. |
| Use fixed screenshot baselines | Quickly detects pixel drift | Font and engine differences create fragile noise. Semantic, geometry, overflow, focus, and state assertions protect the user outcomes across engines. |
| Run the entire suite in all three browser engines | Maximum browser coverage | It roughly triples a large integration suite. The high-risk workspace flow runs in all engines while all historical flows remain authoritative on Chromium. Expand the matrix as runtime permits. |

## Known gaps and next increments

- The single-file frontend still contains duplicated inline styles and large feature modules. Move proven patterns into modules only after the workspace behavior stabilises.
- Automated browser checks do not replace a manual screen-reader pass, real camera/microphone permission testing, high zoom, or forced-colors validation.
- Video remains the existing peer/signalling implementation; there is no screen sharing, recording indicator redesign, or managed TURN capability in this UI increment.
- The whiteboard is a revisioned snapshot surface, not a real-time CRDT with presence cursors.
- Full-suite Firefox/WebKit coverage is deferred; only the focused workspace smoke is cross-engine.
- Visual regression baselines remain deferred until the second-increment layouts settle across hosted fonts and CI engines.
