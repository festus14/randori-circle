# Randori Circle UI redesign spec (phase 1)

Status: proposed. Scope: issue #47. Baseline captured 2026-10-19.

This document is the audit and plan for a staged redesign of the single-file
client (`index.html`). Phase 1 delivered the screenshot pipeline and this spec.
Later phases implement the work packages in section 10. No package may change
authentication, invitation, roster, pairing, scheduling, retention, or
execution protocols except the new invite-request package (WP-L2), which is
specified separately in section 7.

## 0. How to see the UI

`scripts/ui-screenshots.mjs`, run by the manual workflow
`.github/workflows/ui-screenshots.yml`, captures full-page PNGs at mobile
(393x852 @3x, touch) and desktop (1440x900):

- Public production pages, read-only. Every non-GET/HEAD request is aborted and
  listed in `manifest.json`. In the baseline run, the only blocked writes were
  14 client-log `POST /api/logs` calls.
- Signed-in screens from the loopback runtime (`scripts/local-server.mjs`) over
  a fresh temporary database. State is created through product endpoints and UI
  only, as in `tests/e2e/pairing-real-runtime.spec.ts`.

```bash
gh workflow run ui-screenshots.yml --ref <branch>     # the file is on main
gh run download <run-id> -D /tmp/shots
```

Baseline: run 39218900080
(https://github.com/festus14/randori-circle/actions/runs/39218900080),
artifact `ui-screenshots-39218900080-1`. It has 106 PNGs, 0 failed steps, and
is 37 MB, so it is kept as an artifact (30-day retention) rather than
committed. Re-run the workflow on `main` to regenerate it. File names follow
`<viewport>__<screen>.png`.

Local-runtime caveat: the loopback CSP removes CDN scripts, so local
screenshots show the plain `<textarea>` editor instead of Monaco. Production
renders Monaco. Since WP-F both runtimes render the self-hosted Geist Sans
(the baseline captures predate it and show Inter or system fonts).

## 1. Owner decisions (2026-10-19)

1. **Bold new brand.** Use a new accent palette instead of lime `#c8f6a0`, a new
   logo mark and wordmark, and new self-hosted typography. Ship full dark and
   light themes, both WCAG 2.2 AA. See sections 5 and 6.
2. **The landing page explains the product and lets visitors request an invite.**
   It has the value pitch, how it works in 3 steps, a privacy note, Sign in /
   Open my invitation for members, and a public **Request an invite** form that
   the owner reviews. See sections 4 and 7.

## 2. Top 10 problems (ranked by user impact)

| # | Problem | Evidence |
|---|---|---|
| 1 | **The dashboard has no hierarchy.** The one thing a user must do next (publish, confirm availability, agree a time) is at the bottom, below an empty "Next session" gap, admin Logs, and a Sign out button. | `desktop__app-owner-first-route.png`, `mobile__dashboard-owner-no-pairing.png` |
| 2 | **First-run onboarding contradicts itself.** The anonymous welcome banner ("Start → Create account") stays fixed on screen after signup, during profile setup, and on the dashboard. Profile says "Step 2 of 3" with no stepper. A separate 5-step modal tour and a "Getting started" checklist describe the same steps three different ways. | `desktop__onboarding-3-first-route-after-signup.png`, `desktop__dashboard-member-first-run-checklist.png`, `desktop__onboarding-tour-step-4.png` |
| 3 | **The landing page does not sell the product.** The headline is "Randori Circle / Practice together". The "new" badge, "Circle summary 1 members / 0 weeks", a progress bar and an "illustration" mock card read as debug output. The main CTA "Use an invitation" does nothing useful without a link. Strangers have no way to ask to join. | `desktop__landing.png`, `mobile__landing.png`, `mobile__landing-use-invitation-clicked.png` |
| 4 | **Implementation jargon is shown to users.** "Sync / BROWSER STATE", "tab 73t6 • 2s ago", "Browser-tab sync ready", "authorization-gated", "evaluation cases remain on the server", "development identity adapter", "Groq router", "Batched client+server logs… see _randori_log", raw invitation hashes (`f96d3d61dcbb`) and ISO timestamps. | `desktop__availability-member-unsaved.png`, `desktop__circle-owner-two-members.png`, `desktop__landing.png` |
| 5 | **The pair workspace is a long scrolling page, not a workspace.** Two empty video tiles take the first screen. Below the editor are 7 stacked panels, including two separate AI-feedback panels. There are two "Join Session" buttons, a truncated room select ("Your pairing ro"), and textarea placeholders that show literal `\n`. On mobile the page is about 10,000 px tall. | `desktop__workspace-after-run.png`, `mobile__workspace-editor-viewport.png`, `mobile__catalogue-empty-filter.png` |
| 6 | **Error and loading states disagree with each other.** When offline, the chip says "CURRENT CYCLE PUBLISHED" while the body says pairings could not be loaded, the "Available" button still looks pressable, and "Browser-tab sync ready" stays green. A paired dashboard shows "Pairing status unknown — retry" in the checklist. Skeletons never resolve in "Recent pairings". | `mobile__state-offline-pairing.png`, `desktop__dashboard-paired-with-chat.png`, `mobile__state-api-unavailable.png` |
| 7 | **Mobile navigation hides content.** The tab bar shows 4 of 5 tabs and History is clipped off-screen with no affordance. The topbar takes about 120 px before any content. The account pill is the only way to reach Account security and Sign out. | `mobile__dashboard-owner-no-pairing.png`, `mobile__workspace-editor-viewport.png` |
| 8 | **Primary buttons look disabled.** "Use an invitation" is dimmed in dark mode and washed out in light mode. Disabled actions in Account security ("Link Google", "Remove password") have no nearby reason. Pill, chip, kbd and button styles overlap (about 6 visual button variants). | `desktop__landing-light.png`, `mobile__account-security-dialog.png`, `desktop__invite-no-token.png` |
| 9 | **Recovery pages are dead ends.** `/invite` without a token shows "This invitation is unavailable" next to an enabled-looking "Create account" button. `/verify` and `/reset-password` give a one-line error with no next action (sign in, request a new link, contact the owner). | `desktop__invite-no-token.png`, `desktop__verify-no-token.png`, `mobile__reset-password-no-token.png` |
| 10 | **Some states mislead users about their data.** Clearing the catalogue filter to zero results swaps the selected exercise to "Unavailable workspace exercise / Catalogue unavailable", which suggests the user's data is broken. Admin "Run Demo / Reset Demo" sit next to a real published cycle. The circle roster appears twice for owners (roster plus "Membership settings"). | `mobile__catalogue-empty-filter.png`, `desktop__pairing-owner-published.png`, `desktop__circle-owner-two-members.png` |

## 3. Per-screen audit

Names refer to files in the baseline artifact. Unless noted, each screen has
both a `mobile__` and a `desktop__` capture.

### Public

- **Landing** (`landing`, `landing-above-fold`, `landing-returning`, `landing-light`)
  - The value proposition is weak: "Practice together" names neither interviews
    nor peers.
  - The hero card is a box nested in a box. The right column stacks 4 dashed
    cards of equal weight.
  - The live "Circle summary" (1 member, 0 weeks) is social proof working
    backwards for a small private circle. Remove it from the public page.
  - The tab bar (Pairing/Code/Board/History) is shown to anonymous visitors and
    leads nowhere useful.
  - The 11 px all-caps topbar tagline repeats the hero.
  - The first-visit banner covers the bottom of the viewport on mobile and has
    3 competing actions.
  - Light theme: the primary CTA reads as disabled (lime on white).
- **Sign-in dialog** (`signin-dialog`) is the best screen today. Mobile uses a
  correct bottom sheet. Problems:
  - The description repeats itself ("Access your private… / Use your existing…").
  - There is a large dead gap between the fields and the actions.
  - "Forgot password?" sits on the same row as Cancel and the primary button.
- **Forgot password** (`forgot-password-dialog`): the copy is good. Same layout
  issues as sign-in. Three buttons in one row (Back / Cancel / Send).
- **Create account sheet** (`onboarding-2-create-account`, mobile): the sheet
  overflows to the right at 393 px. Input borders and the primary button are cut
  off.
- **`/invite` (no token)** (`invite-no-token`): the instructions and status
  contradict each other, and the CTA stays enabled-looking. Most of the screen
  is empty.
- **`/verify`, `/reset-password` (no token)**: these are dead ends. They need an
  illustration-free empty state with one primary recovery action.
- **Signed-out deep link** (`deep-link-join-signed-out`): the retitled sign-in
  ("Sign in to join your pairing room") is good. Keep it.

### Onboarding (invited member)

- **Invite verified** (`onboarding-1-invite-verified`): this is a correct
  server-verified state. However, the anonymous banner overlaps it, and the
  "local account / development identity adapter" copy is shown.
- **First route after signup / profile** (`onboarding-3-…`, `onboarding-4-profile-setup`)
  - "Step 2 of 3 • 30s" has no visible steps.
  - Twelve unlabeled avatar color dots.
  - The LeetCode handle field gets equal weight with the required fields.
  - "Weekly availability" and "Email reminders" are embedded mid-form as cards.
  - The Save button is far from the fields on desktop.
- **Tour** (`onboarding-tour-step-1`, `onboarding-tour-step-4`): the blurred
  full-screen modal hides the UI it describes. It duplicates the checklist.
- **First-run dashboard** (`dashboard-member-first-run-checklist`): the
  checklist is at the bottom. "This week's pairing is late" is shown to a new
  member as an error.

### Signed-in

- **Dashboard** (`dashboard-owner-no-pairing`, `dashboard-paired-schedule-empty`,
  `dashboard-paired-with-chat`, `dashboard-paired-light`)
  - Three stat cards of equal weight put "0 completed sessions" first.
  - The "Next session" section is an empty 120 px gap until data arrives, and
    there is no skeleton.
  - The pair card has 4 buttons plus a raw session URL.
  - "Agree a time" has a native datetime input and separate proposal, accept
    and agreed blocks. The agreed state has a heavy lime border.
  - Chat is a long inline card.
  - Admin Logs and Sign out sit in the main flow.
- **Schedule** (`schedule-proposal-sent`, `schedule-proposal-received`,
  `schedule-agreed`)
  - The proposer sees "✓ Accept" on their own proposal.
  - Time-zone text is a dense sentence.
  - "Add calendar", "Add meeting link" and "Clear agreement" have the same
    weight.
- **Chat** (`chat-viewport`): the retention notice sits permanently above the
  messages. "Mine" bubbles are tinted only slightly differently. The room id
  chip (`WEEK_1_PAIR_1`) is shown.
- **Pairing tab** (`pairing-owner-before-publication`, `pairing-owner-published`,
  `availability-member-unsaved`, `availability-member-saved`)
  - Availability, the most important weekly action, is nested inside a card
    titled "Sync / Browser state".
  - The inherited-choice warning uses a dashed yellow box under already-saved
    text.
  - The "This week" card is mostly empty.
- **Workspace** (`workspace-editor`, `workspace-editor-viewport`,
  `workspace-after-run`, `workspace-run-results-viewport`, `workspace-editor-light`)
  - Problems as in item 5 of section 2.
  - The toolbar wraps into 3 rows.
  - Test results are stacked full-width cards, one per case.
  - "Shared session controls", "Wrap up", "Private meeting link" and the AI
    panels are unrelated panels in one column.
- **Whiteboard** (`workspace-whiteboard`)
  - The toolbar uses emoji and unicode glyphs (✋ ☆ ⌫).
  - The canvas background is warm brown in dark mode, which clashes with the
    rest of the UI.
  - The board is a separate top-level tab instead of part of the room.
- **Catalogue** (`catalogue-browse`, `catalogue-empty-filter`): there is no
  browse view. The catalogue is a 300 px side pane with a select. The empty
  filter causes problem 10.
- **History / recap** (`history`, `history-recap`): the structure is readable,
  but the 3-column header puts "1 PAIRING" in the middle. The activity list is
  a plain ordered list with no avatars.
- **Circle** (`circle-owner-before-invite`, `circle-invitation-created`,
  `circle-owner-two-members`, `circle-member-view`)
  - Roster, invite form, raw invitation list, membership settings and member
    search are all in one card.
  - The "How Randori works" card is static marketing inside the app ("1 Add
    crew 2-12 people").
- **Account menu / security** (`account-menu-open`, `account-security-dialog`)
  - The menu is fine.
  - In the security sheet, disabled buttons look like normal buttons with gray
    text, and the reason is in small print below.
- **States** (`state-dashboard-loading`, `state-api-unavailable`,
  `state-pairing-api-unavailable`, `state-offline-pairing`)
  - Spinners sit inside stat cards.
  - The Circle tab count reads "0" while loading and "—" on error.
  - On 503 the checklist turns into four red rows. There is no single page-level
    banner such as "We can't reach Randori. Retry".

## 4. Information architecture and navigation

Principle: **one home, one room, one place for settings.** Weekly practice is a
loop: confirm availability → get paired → agree a time → practise → recap. The
navigation follows that loop.

Signed-in primary navigation (left sidebar at 1024 px and wider; bottom tab bar
with 4 items plus a "More" sheet on mobile):

| Item | Contents | Replaces |
|---|---|---|
| **Home** | Current-cycle hero card: one state machine (needs availability → waiting for pairing → paired: agree a time → session today → recap). Partner, schedule, chat preview. "This cycle" timeline. | `#view-dashboard`, availability part of `#view-pair` |
| **Room** | The pair workspace: editor, run results, whiteboard (as a tab inside the room), chat drawer, session controls, wrap-up. It is disabled with an explanation when unpaired, with a "Practise solo" option. | `#view-code`, `#view-board` |
| **Practice** | Catalogue browse view: list or grid, filters, exercise detail, "Practise solo". | catalogue pane inside `#view-code` |
| **History** | Past cycles and recaps. | `#view-history` |
| **Circle** | Members. Owners also get Invitations, Invite requests (new) and Membership settings as sub-tabs. | `#view-circle`, publish controls from `#view-pair` |

The account menu holds Profile, Notifications, Account security, Theme, Sign
out and Sign out everywhere. Admin-only diagnostics (Logs, demo seeding) move to
an owner-only "Diagnostics" item under Circle and are hidden by default.

Constraints:

- Keep the existing view ids, `#tab-*` ids, `aria-controls` and
  `aria-labelledby` pairs, and the `data-tab` values (`circle|pair|code|board|history`).
  `tests/unit/ui-shell-contract.test.mjs` and many e2e specs depend on them.
- New navigation is a presentation layer. "Home" maps to the dashboard route,
  "Room" to `data-tab="code"`, and Board becomes a sub-tab that still clicks
  `[data-tab="board"]`.
- Keep the deep links `/join/<room>`, `?view=`, `/invite#invite=`, `/verify`
  and `/reset-password`, and the `_randoriExplicitNavigation` intent.
- Anonymous users never see app navigation, only the marketing header.

## 5. Brand, logo and visual language

### 5.1 Logo concepts

Randori is freestyle practice against several partners in turn. The mark shows
a circle of rotating partners with "you" at the centre. Every concept uses
`currentColor` plus one accent, works at 16 px, and is pure SVG with no fonts.

**Concept A — "Rotation" (recommended).** Three arcs chase each other around a
centre dot. It reads as a circle, as rotation, and as a group.

```svg
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32" width="32" height="32" role="img" aria-label="Randori Circle">
  <g fill="none" stroke="currentColor" stroke-width="3.2" stroke-linecap="round">
    <path d="M18.85 5.37A11 11 0 0 1 26.63 18.85"/>
    <path d="M23.78 23.78A11 11 0 0 1 8.22 23.78" stroke="var(--rc-accent,#7C8CFF)"/>
    <path d="M5.37 18.85A11 11 0 0 1 13.15 5.37"/>
  </g>
  <circle cx="16" cy="16" r="3.4" fill="currentColor"/>
</svg>
```

**Concept B — "Open circle, two partners."** An ensō-like ring with a gap, and
two dots facing each other. Warmer and more personal, but less distinctive at
16 px.

```svg
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32" width="32" height="32" role="img" aria-label="Randori Circle">
  <path d="M21.5 6.47A11 11 0 1 1 10.5 6.47" fill="none" stroke="currentColor" stroke-width="3.2" stroke-linecap="round"/>
  <circle cx="12" cy="17" r="2.8" fill="currentColor"/>
  <circle cx="20" cy="17" r="2.8" fill="var(--rc-accent,#7C8CFF)"/>
</svg>
```

**Wordmark:** "Randori" in weight 650 followed by "Circle" in weight 450, in the
brand sans, tracking −0.02em, 8 px gap after the mark. Favicon: Concept A on a
rounded square in `--color-accent`, with the mark in `--color-on-accent`. Ship
`assets/brand/mark.svg`, `assets/brand/favicon.svg` and a 180 px PNG
apple-touch icon.

### 5.2 Palette options

All pairs below were checked with the WCAG relative-luminance formula. Body and
secondary text are at least 4.5:1 on canvas, surface and raised surfaces.
Control boundaries are at least 3:1.

**Option A — "Dojo Indigo" (recommended).** Cool, focused, calm under pressure.
It is distinct from the current lime and does not compete with green/red test
results.

| Token | Dark | Light |
|---|---|---|
| canvas | `#0B0D12` | `#F7F8FB` |
| surface | `#12151C` | `#FFFFFF` |
| surface-raised | `#1A1E27` | `#F0F2F7` |
| border | `#2A3040` | `#DDE1EA` |
| control-border | `#5A6378` (3.0:1) | `#8790A3` (3.2:1) |
| text | `#EEF0F6` (17.1:1) | `#0E1220` (17.6:1) |
| text-secondary | `#B4BBCB` (10.1:1) | `#3D4558` (9.0:1) |
| text-muted | `#8C95A8` (6.5:1) | `#5B6478` (5.6:1) |
| accent (action) | `#8B97FF` (7.4:1) | `#4F5BD5` (5.2:1) |
| on-accent | `#0B0D12` (7.4:1 on accent) | `#FFFFFF` (5.5:1) |
| success | `#4ADE9B` | `#0F7546` (5.1:1 on raised) |
| warning | `#F5C451` | `#8A5A00` (5.3:1 on raised) |
| danger | `#FF7A85` | `#C22F3D` (5.0:1 on raised) |
| info | `#6CC4FF` | `#1B63A6` (5.5:1 on raised) |
| focus ring | `#A5B0FF` | `#4F5BD5` |

**Option B — "Ember & Ink."** Warm vermilion with warm stone neutrals. It feels
more martial-arts and energetic, but red-orange accents are easy to confuse
with danger states.

| Token | Dark | Light |
|---|---|---|
| canvas / surface / raised | `#0F0D0C` / `#171413` / `#201C1A` | `#FAF8F6` / `#FFFFFF` / `#F3EFEB` |
| border / control-border | `#332D2A` / `#6B625C` (3.1:1) | `#E3DCD5` / `#8F857E` (3.6:1) |
| text / secondary / muted | `#F5F1EE` / `#C9C0BA` / `#9C928B` | `#1C1715` / `#4A413C` / `#6B615A` |
| accent / on-accent | `#FF7A59` / `#1A0E0A` (7.4:1) | `#C2410C` / `#FFFFFF` (5.2:1) |
| success / warning / danger / info | `#5BD49A` / `#F2C14E` / `#FF6B7A` / `#7CB8FF` | `#116B33` / `#92400E` / `#B91C1C` / `#1D4ED8` |

**Recommendation: Option A.** Each status color also gets a surface tint for
banners: 12% of the status color over surface in dark mode and 10% in light
mode, re-verified at 4.5:1 for text on top.

### 5.3 Typography

The production CSP allows `font-src 'self'`, and the local CSP allows only
`'self' data:`. Fonts must therefore be **self-hosted** as WOFF2 under
`assets/fonts/` (the local server already serves `assets/`). Remove the Google
Fonts `<link>` once the self-hosted fonts land, and keep the Google Fonts
entries out of the CSP.

- **Option A (approved 2026-10-19, amended):** **Geist Sans** only (variable,
  400–700, SIL OFL) for all UI text, including timers, countdowns and stats,
  which use `font-variant-numeric: tabular-nums`. **No Geist Mono is
  shipped.** Code-editing surfaces (the editor textarea and Monaco, `code`,
  `pre`, `kbd`, run output) use the system monospace stack through the
  `--font-mono` token:
  `ui-monospace, "SF Mono", SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace`.
  Geist Sans is subset to Latin plus Latin-1 and common punctuation
  (`assets/fonts/geist-sans-latin-var.woff2`, about 23 KB), preloaded, with
  `font-display: swap`. Sans fallback stack:
  `system-ui, -apple-system, "Segoe UI", Roboto, sans-serif`. The OFL text is
  in `assets/fonts/OFL.txt`.
- **Option B (not chosen):** **Inter** variable for UI and **JetBrains Mono**
  for code. Both are OFL. This option is safer and more familiar, but less
  distinctive.

Type scale (1.200 minor third, rem-based, 16 px root; today the root is 14 px):

| Token | Size / line-height | Use |
|---|---|---|
| `--text-xs` | 12 / 16 | captions, badges |
| `--text-sm` | 14 / 20 | secondary text, controls |
| `--text-md` | 16 / 24 | body (default) |
| `--text-lg` | 18 / 28 | card titles |
| `--text-xl` | 22 / 28 | section titles |
| `--text-2xl` | 28 / 34 | page titles |
| `--text-display` | clamp(36px, 6vw, 56px) / 1.05 | landing hero only |

Weights: 450 body, 550 emphasis, 650 headings. All-caps text is allowed only in
badges, never in headings. Use `font-variant-numeric: tabular-nums` for timers,
countdowns and stats.

## 6. Design tokens

Tokens are CSS custom properties in `:root` (dark) and `:root.light`. The
existing canonical `--color-*` names stay, because
`tests/unit/ui-shell-contract.test.mjs` asserts them. New names are added, and
legacy aliases (`--bg`, `--ink-*`, `--accent`, `--ok`…) keep resolving to them
until WP-Z removes the aliases.

```css
:root{
  /* color: the existing contract names keep their meaning; values come from Option A */
  --color-canvas:#0B0D12; --color-surface:#12151C; --color-surface-raised:#1A1E27;
  --color-surface-active:#222734; --color-border:#2A3040; --color-control-border:#5A6378;
  --color-text:#EEF0F6; --color-text-secondary:#B4BBCB; --color-text-muted:#8C95A8;
  --color-action:#8B97FF; --color-action-hover:#A1ABFF; --color-on-action:#0B0D12;
  --color-success:#4ADE9B; --color-warning:#F5C451; --color-danger:#FF7A85; --color-info:#6CC4FF;
  --color-focus:#A5B0FF;
  --color-success-surface:#14301F; --color-warning-surface:#33290F;
  --color-danger-surface:#3A1A20; --color-info-surface:#10263A;
  --color-scrim:rgb(5 6 10 / .64);

  /* spacing: 4 px base, 8 pt rhythm */
  --space-0:0; --space-1:4px; --space-2:8px; --space-3:12px; --space-4:16px;
  --space-5:20px; --space-6:24px; --space-8:32px; --space-10:40px; --space-12:48px; --space-16:64px;

  /* radius */
  --radius-xs:6px; --radius-sm:8px; --radius-md:12px; --radius-lg:16px; --radius-xl:24px; --radius-full:999px;

  /* elevation (dark relies on surface steps plus a subtle shadow) */
  --shadow-1:0 1px 2px rgb(0 0 0 / .30);
  --shadow-2:0 4px 12px rgb(0 0 0 / .32), 0 1px 2px rgb(0 0 0 / .24);
  --shadow-3:0 16px 40px rgb(0 0 0 / .45), 0 2px 6px rgb(0 0 0 / .25);

  /* z-index scale (replaces the ad-hoc 40/50/55/70/80/85/90/120) */
  --z-base:0; --z-sticky:100; --z-dropdown:200; --z-banner:300; --z-overlay:400;
  --z-modal:500; --z-toast:600; --z-skip-link:700;

  /* motion */
  --ease-out:cubic-bezier(.2,.8,.2,1); --ease-in-out:cubic-bezier(.4,0,.2,1);
  --dur-1:120ms; --dur-2:180ms; --dur-3:260ms;

  /* layout */
  --content-max:1200px; --reading-max:680px; --sidebar-w:240px; --topbar-h:56px;
  --tap-min:44px;
}
```

Rules:

- Color comes only from tokens. Inline `style="color:#…"`, `background:#c8f6a0`
  and hard-coded `#0f0f10` must go. There are 388 inline `style=`
  attributes in `index.html` today.
- Spacing comes only from `--space-*`. Gaps of 6, 7, 9, 10 and 14 px are snapped
  to the 4/8 grid.
- Motion: `--dur-*` with `--ease-*`. Everything is wrapped in the existing
  `@media(prefers-reduced-motion:reduce)` rule (keep it, it is asserted).
  Skeleton shimmer becomes a static tint when motion is reduced.
- Breakpoints: 0–599 (mobile), 600–1023 (tablet), 1024+ (desktop sidebar). Keep
  the asserted 520 and 640 media queries as compatibility hooks during the
  migration.

## 7. Landing page and invite requests

### 7.1 Landing structure (anonymous `/`)

1. **Header** (64 px): logo and wordmark on the left. On the right, "Sign in"
   (ghost) and "Request an invite" (primary). No app tabs.
2. **Hero** (centred, at most 720 px wide):
   - Eyebrow: "Private · invite-only".
   - H1: **"Mock interviews with people you trust."**
   - Sub: "A small private circle that pairs you with a fellow member every
     week. Agree a time, then solve real coding problems together in a shared
     editor and whiteboard."
   - CTAs: **Request an invite** (primary) and **I have an invitation**
     (secondary, opens a help popover: "Open the link from your invitation
     email"). Below them, the text link "Already a member? Sign in".
3. **How it works (3 steps)**, each with an icon, a title and one line:
   1. **Get paired** — "Each week the circle pairs available members. Odd
      number? Someone gets a solo practice room."
   2. **Agree a time** — "Propose times in your own time zone and chat with
      your partner."
   3. **Practise together** — "Shared editor, whiteboard, and verified test
      runs in JavaScript or Python. Swap interviewer and candidate."
4. **Product glimpse:** a static, honest screenshot of the Room in a device
   frame, captured by the pipeline. No live stats.
5. **Trust and privacy** (3 short points): "Invite-only — members are
   approved by the circle owner." "Your sessions stay private to you and your
   partner." "No recruiters, no ads, no public profiles." Link to a privacy
   note.
6. **Request an invite form** (anchor `#request-invite`): see 7.2.
7. **Footer:** © and owner contact, privacy, theme toggle.

Remove from the public page: the circle summary stats, the "new" badge, the
countdown progress bar, the "illustration" card, and the first-visit welcome
banner.

### 7.2 Request-an-invite form (UI)

Fields:

- Name (2–60 characters).
- Email.
- "What are you preparing for?" (optional, at most 280 characters, with a
  character counter).
- A hidden honeypot input named `website`, with `tabindex=-1`,
  `autocomplete=off`, visually hidden, and `aria-hidden`.

Submission behaviour:

- Submit shows a pending state on the button.
- The success copy is always the same, whatever the outcome (no enumeration):
  "Thanks — if the circle has room, you'll get an invitation by email."
- The form then collapses to that message.
- Errors: field-level validation messages linked with `aria-describedby`. A
  429 shows "Too many requests — try again later."

### 7.3 Backend (work package WP-L2, its own PR)

**Migration.** Use the next free version. `main` is at v19 and PR #242 reserves
v20, so this is **v21** unless the numbering has moved by implementation time.
Re-check `db/migration-plan.js` before writing the migration. It must be
append-only and checksummed like the others, and run only through the protected
`turso-production-migration` workflow.

```sql
CREATE TABLE invite_requests (
  id INTEGER PRIMARY KEY,
  circle_id INTEGER NOT NULL REFERENCES circles(id),
  email_hash TEXT NOT NULL,            -- HMAC(IDENTITY_EMAIL_HASH_KEY, normalized email)
  email_ciphertext TEXT NOT NULL,      -- or plaintext if the policy allows; owner needs it to invite
  name TEXT NOT NULL CHECK (length(name) BETWEEN 2 AND 60),
  note TEXT CHECK (note IS NULL OR length(note) <= 280),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','declined','expired')),
  created_at INTEGER NOT NULL,
  decided_at INTEGER, decided_by INTEGER REFERENCES users(id),
  invitation_id INTEGER REFERENCES invitations(id),
  UNIQUE (circle_id, email_hash, status) -- at most one pending per email per circle
);
CREATE INDEX invite_requests_circle_status ON invite_requests(circle_id, status, created_at);
```

**Endpoints** (routed in `api/invitations.js`, with matching `vercel.json`
rewrites and `scripts/local-server.mjs` routes):

- `POST /api/invite-requests` (public)
  - Validates the input.
  - If the honeypot is filled, returns 202 and stores nothing.
  - Rate limits through the existing `auth_rate_limits` table with a new
    `invite-request` action: 5 per IP and 3 per email-hash per hour, plus a
    global circuit breaker of 50 per day.
  - Always returns `202 {ok:true}`, whether the email is already a member,
    already invited, or a duplicate pending request, so there is no
    enumeration.
  - Targets the single public primary circle (the owner's), configured
    server-side. The client never chooses the circle.
  - Gated by a new `INVITE_REQUESTS_ENABLED` env flag. The flag is exposed
    through `/api/auth/capabilities`, so the form is shown only when it is
    enabled.
- `GET /api/invite-requests?status=pending` (primary-circle owner only):
  paginated list.
- `POST /api/invite-requests/decision` with `{id, decision:'approve'|'decline', expected_status:'pending'}`
  (owner only, recent-auth not required). Approval creates a normal
  email-bound single-use invitation through the existing invitation code path
  and enqueues the existing `invitation.email.requested` outbox event in the
  same transaction. Decline sends nothing. A compare-and-swap on the status
  prevents a double approval.

**Owner notification:** a new outbox event `invite_request.email.requested`
(owner only, at most one digest per hour, no applicant content beyond name and
note). Delivered by the existing outbox worker and Resend.

**Privacy and retention:**

- Pending requests expire after 30 days (status `expired`).
- Declined and expired rows are deleted 30 days after the decision by the
  existing retention cron pattern (see `docs/CHAT_RETENTION.md`). Approved rows
  keep only `invitation_id` and timestamps.
- The email is never logged or sent to Sentry.
- The privacy note on the landing page states this.

**Admin UI:** Circle → "Invite requests" sub-tab (owner only). It shows a list
with name, note and relative time, plus Approve / Decline buttons, an empty
state ("No pending requests") and an error/retry state. After approval it shows
the created invitation in the existing Invitations list.

**Tests:**

- Unit tests for validation, the honeypot, rate limits, no-enumeration
  responses, the CAS decision, and the transactional outbox write.
- A real-runtime e2e test: request → owner approves → invitation email captured
  → invitee signs up.
- Migration rehearsal tests.

## 8. Onboarding flow

Today: invite link → banner + verified card → account sheet → profile (labelled
"step 2 of 3") → dashboard with a separate 5-step modal tour and a 4-item
checklist.

Proposed: a single stepper, `invite → account → profile basics → availability → what happens next`.
It is rendered on the `#view-invite` / `#view-profile-setup` surfaces with a
persistent progress indicator: `<ol aria-label="Setup progress">` with
`aria-current="step"`, plus "Step n of 5" text.

1. **Invitation** (server-verified): "You're invited to <Circle name> by
   <owner>." One button: "Create your account". On invalid or expired links,
   show "Request a new invite" and "Sign in".
2. **Account:** the existing auth sheet in signup mode (Google, or email and
   password). Fix the mobile overflow.
3. **Profile basics:** display name, time zone (auto-detected), and interview
   focus (DSA / System design / Both). Bio, LeetCode handle and avatar color go
   under "Add more (optional)". **Skippable:** "Skip for now" saves the
   server-required minimum.
4. **Availability for the upcoming cycle:** a large two-choice card (Available
   / Skip this week) with the cutoff time in the user's time zone. It uses the
   existing explicit availability endpoint and its versioned CAS. Skippable;
   the inherited state is shown honestly.
5. **What happens next:** a timeline ("Pairings publish <Sun 08:00>. You'll get
   an email. Then agree a time with your partner."), an email reminder toggle
   (existing preference), and "Go to Home".

Rules:

- Progress is **server-authoritative.** It is driven by
  `window._randori_onboarding_authority` (see `docs/SERVER_AUTHORITATIVE_ONBOARDING.md`).
  Browser storage may remember dismissal only.
- The anonymous welcome banner and the 5-step modal tour are removed. "Restart
  tour" becomes "Setup guide" in the account menu. After setup, the Home hero
  card replaces the checklist.
- Never show "pairing is late" to someone who joined after the cutoff. Show
  "You'll be included from <next cycle>" instead.

## 9. Component inventory

Build these once in the CSS layer (classes prefixed `rc-`), document them in
this file, and migrate screens onto them. Every component defines hover, focus
(3 px `--color-focus` ring, 2 px offset), active, disabled (with a visible
reason), loading and error states, and has a 44 px minimum target on coarse
pointers.

| Component | Variants / notes | Replaces |
|---|---|---|
| Button | primary, secondary, ghost, danger; sizes sm (32), md (40), lg (48); icon-only with `aria-label`; loading spinner keeps the width | `.btn`, `.btn.secondary`, `.btn.ghost`, most `.pill` buttons |
| Icon | an inline SVG sprite (Lucide-style, MIT) at 16/20 px | emoji and unicode glyphs (📷 🎤 ✋ ☆ ⌫ ⇄ 〈〉 ◫ ↺ ◍) |
| Input, Textarea, Select | label above, help text, error text (`aria-describedby`, `aria-invalid`), counter; native date-time is wrapped with a formatted preview | `.input`, `.textarea`, `.select` |
| Segmented control / Choice card | single choice (focus, availability) | `.chip` groups, `#availActions` |
| Card | flat (border only) and raised; header with title, meta and actions slot | `.card`, `.mock-card`, `.partner-card` |
| Dialog / Sheet | centred dialog at 600 px and above, bottom sheet below; focus trap; Escape; scrim; `--z-modal` | `.overlay` and `.modal`, auth and identity overlays |
| Tabs | primary nav (sidebar / bottom bar) and in-page tabs (`role="tablist"`) | `.tabs`, `.tab` |
| Toast | polite live region, auto-dismiss 5 s (paused on hover/focus), max 1 visible, actions allowed | `#toast` |
| Banner / Inline alert | info, success, warning, danger; page-level (offline / API down) and inline; one retry action | `.status-chip` blocks, dashed warning boxes |
| Badge | neutral, status; never all-caps paragraphs | `.kbd` used as a badge, `.status-chip` |
| Avatar | initials on a token color, sizes 24/32/40/56, optional presence dot | `.avatar` |
| Empty state | icon, title, one sentence, one primary action | ad-hoc "No … yet" strings |
| Skeleton | line, block and avatar shapes that match the final layout; static when motion is reduced | spinners inside stat cards |
| Stepper | onboarding progress | `.onboard-progress`, "step 2 of 3" text |
| Menu | account menu (existing keyboard behaviour kept) | `#meMenu` inline styles |
| Timeline | cycle timeline, recap activity | `ol` in the recap, landing progress bar |
| Code toolbar | language, exercise, Run (primary), more-menu (format, copy starter, reset) | `.editor-top` wrapping rows |
| Test result list | compact rows: case n · pass/fail · expand | stacked case cards |

### 9.1 What WP-F shipped (foundations)

WP-F restyles the existing classes in place, so every screen picks up the brand
without markup changes, and adds `rc-` names that share the same rules for new
markup in later packages.

| Legacy class | `rc-` equivalent | Notes |
|---|---|---|
| `.btn`, `.btn.secondary`, `.btn.ghost`, `.btn.danger`, `.btn.sm`, `.btn.lg` | `.rc-btn`, `--secondary`, `--ghost`, `--danger`, `--sm`, `--lg`, `--icon` | 32/40/48 px heights; 44 px on coarse pointers. Disabled buttons use a dashed border, the active-surface fill and muted text (legible, clearly unavailable). Light-mode primary is `#4F5BD5` with white text (5.5:1). |
| `.input`, `.textarea`, `.select` | — | Field background `--color-field` (dark: canvas, light: white) so the control border is at least 3:1 inside and outside. Custom select chevron per theme. `aria-invalid="true"` turns the border red. 16 px text on coarse pointers. |
| `.card` | `.rc-card`, `.rc-card--raised` | 16 px radius, flat border plus `--shadow-1`. |
| `.kbd` (badge use), `.status-chip` | `.rc-badge`, `--success`/`--warning`/`--danger`/`--info` | Real `<kbd>`, `<code>`, `<pre>` use `--font-mono`. |
| `.tabs`, `.tab` | `.rc-tabs`, `.rc-tab` | Active tab: indigo-tinted surface and border. |
| `.overlay`, `.modal` | `.rc-dialog` | Scrim `--color-scrim`, `--z-modal`, bottom sheet at 520 px and below (unchanged). |
| `.toast` | `.rc-toast` | Inverse colors, `--z-toast` (above dialogs). |
| — | `.rc-banner` (+ status variants), `.rc-empty`, `.rc-segmented`, `.rc-avatar`, `.rc-skeleton`, `.rc-table`, `.rc-icon` | Building blocks for WP-S onwards. |

- Logo: `assets/brand/mark.svg` (Concept A), `assets/brand/favicon.svg` (mark on
  a `#4F5BD5` rounded square), `assets/brand/apple-touch-icon.png` (180 px). The
  header renders the mark inline (`svg.mark`, accent arc via `.mark-accent`)
  next to the wordmark "**Randori** Circle".
- Icons: `assets/brand/icons.svg` is an original stroke-icon sprite
  (`<svg class="rc-icon"><use href="/assets/brand/icons.svg#i-play"/></svg>`).
  Later packages replace the emoji and unicode glyphs with it.
- z-index: the sticky topbar uses `--z-sticky`, overlays `--z-modal`, toasts
  `--z-toast` and the skip link `--z-skip-link`. `#onboardOverlay` and
  `#identityOverlay` keep their historical order above other overlays.
- Compatibility shim: inline styles that pair an accent fill with `#0f0f10`
  text are forced to `--color-on-action` until WP-Z purges inline colors.
- The production CSP no longer lists the Google Fonts hosts.

### 9.2 What WP-S shipped (shell and navigation)

- **Topbar:** one 56 px row at every width (it was about 120 px on phones):
  mark and wordmark, an icon-only theme toggle (`#themeToggle`, sun/moon from
  the sprite, label "Switch to light/dark theme"), and the account trigger
  (`#meLabel`: initials avatar on the profile color with a contrast-checked
  ink, name, chevron; the name is visually hidden below 600 px but stays in
  the text and the accessible name). The 11 px tagline is gone.
- **Primary navigation** is still the `<nav aria-label="Primary navigation">`
  group of `[data-tab]` buttons, with a new first item **Home** (`#tab-home`,
  `data-nav="home"`, no `data-tab`). Home asks the journey router for the
  right home (dashboard, profile setup, or the landing page for visitors) and
  is `aria-current="page"` while that surface is visible.
  - Below 600 px: a fixed **bottom tab bar** (icon over label, safe-area
    padding). All destinations are direct buttons: six items are at least
    53 px wide at 320 px, so nothing is clipped and no "More" sheet is
    needed yet. Revisit the "4 items plus More" layout once WP-R folds Board
    into the Room and the item set changes.
  - 600–1023 px, and visitors at any width: compact horizontal tabs below the
    topbar (icons hidden at 600–767 px so the row always fits).
  - Members at 1024 px and wider: a **left sidebar** (`--sidebar-w`), sticky
    under the topbar. Arrow keys, Home and End keep working.
- **Account menu:** token-styled `.account-menu` / `.account-menu-item` with
  icons. Items, order and keyboard behaviour are unchanged (Account security,
  Sign out, Sign out everywhere). Theme stays in the topbar so visitors can
  reach it; Profile and Notifications join the menu with WP-O / WP-H.
- **Toast** (`#toast`): `role="status"`, polite and atomic, one at a time,
  5 s auto-dismiss paused on hover or focus, click to dismiss. Bottom-right on
  wide screens, centred above the tab bar on phones.
- **Offline banner** (`#shellConnectionBanner`): a page-level warning banner
  driven by the browser `online`/`offline` events only. API-down detection
  stays with the feature packages.
- The stored theme is applied in `<head>` before first paint.
- Logic lives in `assets/app-shell.js` (ES module, unit-tested in
  `tests/unit/app-shell.test.mjs`); golden paths are in
  `tests/e2e/app-shell-navigation.spec.ts`.

### 9.3 What WP-R shipped (pair room)

- **Editor first, sized to the screen.** `#view-code` is a `.room` that fills
  the viewport below the topbar (and above the bottom tab bar on phones).
  Panels scroll inside the room, so the page no longer grows with results,
  notes or session cards (mobile workspace: about 3,900 CSS px tall before,
  one screen after).
- **Room bar** (`.room-bar`): the room select at full width, presence, the
  code sync badge, the compact role and timer chips (`#roleToggle`,
  `#timerBtn`, mirrors of the shared session controls), a single **Join call**
  (`#vidJoinBtn`; the toolbar "Join Session" button is gone), and a
  **Code / Board** mode switch (`[data-room-mode]`).
- **Call strip** (`#videoBar`) is `hidden` with `data-call="off"` until the
  member joins; then it shows small tiles and the camera / mic toggles
  (`aria-pressed`).
- **Panels** (`#roomPanelTabs`, `role="tablist"`): Code, Problem, Results,
  Session, Notes. Below 1100 px one panel is visible at a time and Code is the
  default. At 1100 px and wider the editor stays visible on the left and the
  tabs drive a side panel on the right (Problem by default; the Code tab is
  hidden there). Arrow keys, Home and End move between tabs. Run brings
  Results forward. The editor is never detached, so Monaco, the CRDT binding
  and the hydration lock are unaffected.
- **Results**: one summary row ("Result: n/m passed") followed by compact case
  rows (`.run-summary`, `.run-case[data-status]`), then the pair run feed.
- **Session**: shared roles and timer, the private meeting link and wrap-up,
  with an empty-state line until the pair room is ready.
- **Notes**: notes and interviewer questions first (real line breaks in the
  placeholders). The two AI panels are merged into one **AI feedback (Beta)**
  section that is off by default (`#aiFeedbackToggle`, `role="switch"`); the
  preference is a presentation setting in `localStorage`
  (`randori-ai-feedback`).
- **Editor toolbar**: language, Run (primary) and a more-menu (Format, Copy
  starter, Reset). Copy starter and Reset now work in the plain editor too;
  Format is disabled there with a visible reason.
- **Board** stays reachable through `[data-tab="board"]` in the primary
  navigation (no nav change in this package); inside the room it is a mode of
  the same room bar. Tools use new sprite icons (`i-pointer`, `i-square`,
  `i-circle`, `i-arrow`, `i-type`, `i-sticky`, `i-undo`, `i-redo`, `i-trash`,
  `i-minus`, `i-maximize`), and the canvas paints the theme card surface
  instead of a fixed brown. Folding Board out of the primary nav (and the
  "4 items plus More" bar) is left for a follow-up coordinated with WP-S.
- Logic lives in `assets/room-layout.js` (ES module, unit-tested in
  `tests/unit/room-layout.test.mjs`); golden paths are in
  `tests/e2e/pair-workspace-layout.spec.ts`. E2E specs that use Session or
  Results controls open the panel first with `openRoomPanel()` from
  `tests/e2e/helpers.ts`.

## 10. Phased implementation plan

### 10.1 Global constraints for every package

- **Preserve the test hooks.** Do not rename or remove any `id` or
  `data-testid` referenced in `tests/e2e/**` or `tests/unit/*contract*.mjs`.
  Run
  `grep -rhoE "getByTestId\('[^']+'\)|locator\('#[A-Za-z0-9_-]+" tests/e2e | sort -u`
  before and after. Keep the static regex contracts in
  `tests/unit/ui-shell-contract.test.mjs` (landmarks, `#tab-*`/`#view-*` pairs,
  `--color-*` tokens defined exactly once per theme, media queries, truthful
  copy guards).
- **Do not change security boundaries.** `escapeHtml` and the node-builder
  renderers stay. Never use `innerHTML` with server data. CSP stays as it is,
  except for removing CDN font hosts.
- **States stay server-authoritative.** Never derive progress, pairing,
  schedule or completion from browser storage. Keep the draft preservation
  (schedule input, chat composer), the CAS conflict handling (workspace 409,
  availability version, schedule version) and the deep links listed in
  section 4.
- **CI.** Each PR must pass `npm test` (deployability, catalogue, runtime-DDL,
  syntax, coverage of at least 52%, e2e including the axe 2.2 AA scans). Each
  PR also runs the `ui-screenshots` workflow on its branch and links the
  before/after file names in the PR body.
- **Line numbers.** The ranges below are from `main` at a106c06 (13,804 lines).
  Anchor on the section ids and comment markers, not on the numbers.

### 10.2 Work packages

Packages in the same wave touch disjoint regions of `index.html` and can run in
parallel. WP-F must land first.

| WP | Wave | Scope | Region of `index.html` (main @ a106c06) |
|---|---|---|---|
| **WP-F Foundations** | 1 (alone) | New tokens (section 6, Option A), self-hosted fonts in `assets/fonts/`, `rc-` component classes (section 9), icon sprite, z-index scale, legacy aliases kept | `<style>` L231–760 only (plus new `assets/fonts/*`, `assets/brand/*`, `<head>` font/favicon links L1–10) |
| **WP-S Shell & navigation** | 2 | Topbar (logo/wordmark), sidebar / bottom nav presentation over the existing `data-tab` buttons, account menu, page-level offline/API banner, toast restyle | markup L919–955 (`.skip-link`…`<nav>`), `#toast` L1483; JS "tabs" L7416–7481 and "theme" L3856–3867 |
| **WP-L1 Landing & public recovery** | 2 | Landing structure (section 7.1, form UI behind the capability flag), `/invite`, `/verify`, `/reset-password` empty/recovery states | `#view-landing` L957–985, `#view-activation` L987–999, `#view-password-reset` L1000–1014, `#view-invite` L1015–1028; JS "HOME differentiated" L10977–11227 |
| **WP-L2 Invite requests (backend + owner UI)** | 2 (separate PR, needs owner approval to migrate prod) | Section 7.3: migration v21+, `api/invitations.js`, outbox event, retention, capability flag, Circle "Invite requests" sub-tab | `api/*`, `db/*`, `vercel.json`, `scripts/local-server.mjs`; in `index.html` only a new owner sub-panel appended after `#circleOwnerPanel` (inside `#view-circle` L1094–1171, coordinate with WP-C) |
| **WP-A Auth dialogs** | 2 | Auth sheet/dialog layout, mobile overflow fix, Forgot/Reset layout, Account security cards with visible disabled reasons, confirm/prompt dialogs | overlays L1409–1467 (`#confirmOverlay`, `#promptOverlay`, `#authOverlay`, `#identityOverlay`); JS auth dialog entry points L2989–3224 and `openIdentity` L3225–3387 (presentation only) |
| **WP-O Onboarding** | 3 (after WP-A, WP-L1) | Stepper (section 8), profile basics plus optional details, availability step, "what happens next"; remove welcome banner and modal tour; "Setup guide" | `#view-profile-setup` L1029–1055, `#welcomeBanner` L1468–1472, `#onboardOverlay` L1473–1482; JS onboarding journey L7641–7872, profile helpers L7923–8132, onboarding authority L13329–13801 |
| **WP-H Home (dashboard, schedule, chat)** | 3 | Hero cycle card state machine, partner card, schedule (proposal/accept/agreed), chat drawer/preview, skeletons, move Logs/Sign out out of the flow | `#view-dashboard` L1056–1093; JS dashboard L8133–8482, schedule L8483–9178, chat L9179–9700 |
| **WP-P Availability & pairing** | 3 | Availability choice card (moved to Home and the onboarding step, still rendered in `#availabilityWrap`), publish controls for owners, hide demo buttons behind Diagnostics, remove "Sync / Browser state" framing | `#view-pair` L1172–1213; JS explicit availability L3388–3412 and `_randori_availability` L3821–3855; pairing L5349–5815 |
| **WP-R Room (workspace, run, board)** | 3 | Room layout: editor-first, collapsible video, toolbar, test result list, session controls/wrap-up/meeting link as a right rail (≥1024) or bottom sheet tabs (mobile), board as an in-room tab, merge the two AI panels, fix `\n` placeholders | `#view-code` L1214–1366, `#view-board` L1367–1396; JS code room L6276–6588, board L6589–6971, video L6972–7415, AI L7493–7640, Monaco L11357–11715, AI frontend L11720–11989; session modules L11991–13327 (presentation only) |
| **WP-K Practice catalogue** | 4 (after WP-R) | Browse view (grid/list, filters, detail, "Practise solo"); the zero-result filter keeps the selected exercise and shows an empty state | catalogue markup inside `#view-code` `.q-pane` (L1239–1267); JS "Original catalogue" L10057–10973 |
| **WP-C Circle & history** | 3 | Circle sub-tabs (Members / Invitations / Membership / Invite requests slot), friendly invitation rows (no hashes, relative dates), remove in-app marketing card; History list and recap timeline | `#view-circle` L1094–1171, `#view-history` L1397–1406; JS people L4036–5348, history L5816–6255 |
| **WP-Z Cleanup & regression** | 5 | Remove legacy aliases and dead CSS, purge inline styles, axe and contrast re-scan in both themes, visual baseline refresh, Firefox/WebKit smoke (issue #47 acceptance) | whole file; no behaviour changes |

The admin logs widget (JS L11232–11347, markup `#logsArea` inside
`#view-dashboard`) moves to Diagnostics in WP-H. Its JS stays untouched apart
from the mount point.

### 10.3 Definition of done per package

- Before/after screenshots for both viewports and both themes are linked in the
  PR.
- No new axe WCAG 2.0/2.1/2.2 A/AA violations. Contrast of new tokens is
  verified (section 5.2 values).
- Keyboard: the package's flows can be completed with Tab, Shift+Tab, Enter,
  Space and Escape, and focus returns correctly from dialogs.
- Loading, empty, error, offline and stale/conflict states for the package's
  data are visually distinct and have one recovery action.
- No inline colors or spacing outside tokens in the touched regions.
- `npm test` passes and the coverage thresholds hold.
