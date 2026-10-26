# Design tokens (WP-Z)

Authoritative token list for Randori Circle. The definitions live in
`index.html` (`:root` dark/default, `:root.light`); this doc is the
human-readable index. If they ever disagree, the code wins and this doc
must be fixed — `tests/unit/ui-shell-contract.test.mjs` pins the
canonical colour tokens in both themes and forbids every alias below
from coming back. The redesign spec ([UI_REDESIGN_SPEC.md](UI_REDESIGN_SPEC.md)
§6) points here instead of duplicating the list.

"Uses" counts are `var(--token)` occurrences in production code
(`index.html`, `assets/*`, `api/*`), measured at the #400 landing.
They are a snapshot, not a contract — the byte-budget check is the
enforced gate.

## Rules

- Colour, spacing, radius, elevation, z-index, motion, type and layout
  come only from the tokens below. No hard-coded hex/`rgb()` colours,
  no ad-hoc `z-index`, no new aliases.
- A token that stops being used is a deletion candidate (see
  [Removed tokens](#removed-tokens)); do not keep "just in case"
  tokens. `assets/legal.css` is the one exception: it redefines a
  subset of the canonical colour/type tokens for the standalone
  `privacy.html` / `terms.html` pages and is deliberately untouched.
- Light theme: `—` in the Light column means `:root.light` does not
  redefine the token and it inherits the dark value (true for every
  theme-independent token — type, spacing, radius, z-index, motion,
  layout — and for `--color-on-avatar`).

## Remaining tokens

89 tokens in `:root` / `:root.light`, plus 4 component-scoped tokens
below. (Pre-#400 triage said 134 distinct definitions in `index.html`;
a corrected parse — one that does not mistake BEM class suffixes such
as `.rc-btn--danger` / `.account-menu-item--legal` for custom-property
definitions — gives 130, of which 31 aliases + 6 dead canonicals were
removed by #400: 130 − 37 = 93 total, 89 in `:root` + 4 scoped.)

### Colour

| Token | Dark (`:root`) | Light (`:root.light`) | `var()` uses in prod |
| --- | --- | --- | ---: |
| `--color-action` | `#8B97FF` | `#4F5BD5` | 59 |
| `--color-action-active` | `#7B88F7` | `#3B47B3` | 1 |
| `--color-action-hover` | `#A1ABFF` | `#4350C4` | 5 |
| `--color-action-subtle` | `#1E2238` | `#EEF0FC` | 20 |
| `--color-border` | `#2A3040` | `#DDE1EA` | 110 |
| `--color-border-strong` | `#3A4256` | `#C5CBD8` | 8 |
| `--color-canvas` | `#0B0D12` | `#F7F8FB` | 7 |
| `--color-code-bg` | `#0E1117` | `#FBFBFD` | 4 |
| `--color-control-border` | `#5A6378` | `#8790A3` | 16 |
| `--color-danger` | `#FF7A85` | `#C22F3D` | 55 |
| `--color-danger-hover` | `#FF949D` | `#A82734` | 1 |
| `--color-danger-surface` | `#3A1A20` | `#F9EAEC` | 11 |
| `--color-field` | `#0B0D12` | `#FFFFFF` | 4 |
| `--color-focus` | `#A5B0FF` | `#4F5BD5` | 16 |
| `--color-info` | `#6CC4FF` | `#1B63A6` | 16 |
| `--color-info-surface` | `#10263A` | `#E8EFF6` | 5 |
| `--color-on-action` | `#0B0D12` | `#FFFFFF` | 5 |
| `--color-on-avatar` | `#0B0D12` | `—` | 1 |
| `--color-on-danger` | `#0B0D12` | `#FFFFFF` | 2 |
| `--color-scrim` | `rgb(5 6 10 / .64)` | `rgb(14 18 32 / .48)` | 1 |
| `--color-success` | `#4ADE9B` | `#0F7546` | 38 |
| `--color-success-surface` | `#14301F` | `#E7F1ED` | 11 |
| `--color-surface` | `#12151C` | `#FFFFFF` | 47 |
| `--color-surface-active` | `#222734` | `#E6E9F0` | 13 |
| `--color-surface-raised` | `#1A1E27` | `#F0F2F7` | 49 |
| `--color-text` | `#EEF0F6` | `#0E1220` | 77 |
| `--color-text-muted` | `#8C95A8` | `#5B6478` | 50 |
| `--color-text-secondary` | `#B4BBCB` | `#3D4558` | 80 |
| `--color-warning` | `#F5C451` | `#8A5A00` | 26 |
| `--color-warning-surface` | `#33290F` | `#F3EFE6` | 10 |

### Typography

| Token | Dark (`:root`) | Light (`:root.light`) | `var()` uses in prod |
| --- | --- | --- | ---: |
| `--font-mono` | `ui-monospace, "SF Mono", SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace` | `—` | 5 |
| `--font-sans` | `"Geist", system-ui, -apple-system, "Segoe UI", Roboto, sans-serif` | `—` | 3 |
| `--leading-2xl` | `1.2143` | `—` | 3 |
| `--leading-display` | `1.05` | `—` | 2 |
| `--leading-lg` | `1.5556` | `—` | 14 |
| `--leading-md` | `1.5` | `—` | 16 |
| `--leading-sm` | `1.4286` | `—` | 41 |
| `--leading-xl` | `1.2727` | `—` | 8 |
| `--leading-xs` | `1.3333` | `—` | 17 |
| `--text-2xl` | `1.75rem` | `—` | 3 |
| `--text-display` | `clamp(2.25rem, 6vw, 3.5rem)` | `—` | 2 |
| `--text-lg` | `1.125rem` | `—` | 17 |
| `--text-md` | `1rem` | `—` | 21 |
| `--text-sm` | `0.875rem` | `—` | 76 |
| `--text-xl` | `1.375rem` | `—` | 8 |
| `--text-xs` | `0.75rem` | `—` | 34 |
| `--tracking-tight` | `-0.02em` | `—` | 8 |
| `--weight-body` | `450` | `—` | 8 |
| `--weight-emphasis` | `550` | `—` | 51 |
| `--weight-heading` | `650` | `—` | 35 |

### Spacing

| Token | Dark (`:root`) | Light (`:root.light`) | `var()` uses in prod |
| --- | --- | --- | ---: |
| `--space-1` | `4px` | `—` | 98 |
| `--space-10` | `40px` | `—` | 6 |
| `--space-12` | `48px` | `—` | 6 |
| `--space-2` | `8px` | `—` | 180 |
| `--space-3` | `12px` | `—` | 152 |
| `--space-4` | `16px` | `—` | 92 |
| `--space-5` | `20px` | `—` | 31 |
| `--space-6` | `24px` | `—` | 23 |
| `--space-8` | `32px` | `—` | 10 |

### Radius

| Token | Dark (`:root`) | Light (`:root.light`) | `var()` uses in prod |
| --- | --- | --- | ---: |
| `--radius-full` | `999px` | `—` | 26 |
| `--radius-lg` | `16px` | `—` | 6 |
| `--radius-md` | `12px` | `—` | 53 |
| `--radius-sm` | `8px` | `—` | 24 |
| `--radius-xl` | `24px` | `—` | 2 |
| `--radius-xs` | `6px` | `—` | 15 |

### Elevation

| Token | Dark (`:root`) | Light (`:root.light`) | `var()` uses in prod |
| --- | --- | --- | ---: |
| `--shadow-1` | `0 1px 2px rgb(0 0 0 / .30)` | `0 1px 2px rgb(16 24 40 / .06), 0 1px 3px rgb(16 24 40 / .06)` | 7 |
| `--shadow-2` | `0 4px 12px rgb(0 0 0 / .32), 0 1px 2px rgb(0 0 0 / .24)` | `0 4px 12px rgb(16 24 40 / .08), 0 1px 3px rgb(16 24 40 / .06)` | 2 |
| `--shadow-3` | `0 16px 40px rgb(0 0 0 / .45), 0 2px 6px rgb(0 0 0 / .25)` | `0 16px 40px rgb(16 24 40 / .16), 0 2px 6px rgb(16 24 40 / .08)` | 3 |

### Z-index

| Token | Dark (`:root`) | Light (`:root.light`) | `var()` uses in prod |
| --- | --- | --- | ---: |
| `--z-dropdown` | `200` | `—` | 1 |
| `--z-modal` | `500` | `—` | 2 |
| `--z-skip-link` | `700` | `—` | 2 |
| `--z-sticky` | `100` | `—` | 2 |
| `--z-toast` | `600` | `—` | 1 |

### Motion

| Token | Dark (`:root`) | Light (`:root.light`) | `var()` uses in prod |
| --- | --- | --- | ---: |
| `--dur-1` | `120ms` | `—` | 31 |
| `--dur-2` | `180ms` | `—` | 4 |
| `--dur-3` | `260ms` | `—` | 1 |
| `--ease-out` | `cubic-bezier(.2,.8,.2,1)` | `—` | 36 |

### Layout and controls

| Token | Dark (`:root`) | Light (`:root.light`) | `var()` uses in prod |
| --- | --- | --- | ---: |
| `--bottom-nav-h` | `64px` | `—` | 4 |
| `--content-max` | `1200px` | `—` | 2 |
| `--control-lg` | `48px` | `—` | 5 |
| `--control-md` | `40px` | `—` | 10 |
| `--control-sm` | `32px` | `—` | 7 |
| `--focus-offset` | `2px` | `—` | 3 |
| `--focus-width` | `3px` | `—` | 4 |
| `--reading-max` | `680px` | `—` | 9 |
| `--select-chevron` | `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='16' height='16' viewBox='0 0 24 24' fill='none' stroke='%23B4BBCB' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpath d='m6 9 6 6 6-6'/%3E%3C/svg%3E")` | `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='16' height='16' viewBox='0 0 24 24' fill='none' stroke='%233D4558' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpath d='m6 9 6 6 6-6'/%3E%3C/svg%3E")` | 1 |
| `--sidebar-w` | `240px` | `—` | 1 |
| `--tap-min` | `44px` | `—` | 26 |
| `--topbar-h` | `56px` | `—` | 10 |

### Component-scoped tokens

Defined on a component selector in `index.html`, not in `:root`
(they only make sense there). Do not promote them to `:root` without
a use outside their component.

| Token | Where | Purpose |
| --- | --- | --- |
| `--room-offset` | `.room` (plus breakpoint overrides) | Height offset for the room view (`height: calc(100dvh - var(--room-offset))`) |
| `--auth-alert-icon` | `.auth-alert`, `.identity-status` | Alert icon data-URI for auth / identity status |
| `--auth-field-icon` | `.auth-input-wrap` | Field icon data-URI for auth inputs |
| `--identity-ok-icon` | `.identity-method` | Success icon data-URI for identity methods |

## Removed tokens

### Legacy aliases (31, removed by #400)

Every alias resolved to exactly one canonical token. All 553
`var(--alias)` uses in `index.html` were migrated to the canonical
(see table), plus the production uses outside it: `var(--accent)` in
`api/data.js` (JS colour string for the solo-practice pair, now
`var(--color-action)`), two `var(--warn)` uses in
`assets/circle-history.css` (one was the fallback trap
`var(--color-warning, var(--warn))` — deleting `--warn` would have
made that fallback invalid, so the fallback was dropped and the
rule is now plain `var(--color-warning)`), one `var(--card)` test
harness style in `tests/e2e/ui-shell-accessibility.spec.ts`, and
`var(--accent)` as a non-hex input in
`tests/unit/pairing-view.test.mjs` (premise unchanged: `avatarInk`
returns `''` for any non-hex string). `--accent-4` and
`--shadow-soft` had zero uses anywhere and were deleted with no
call-site migration.

| Alias | → Canonical | Uses in `index.html` |
| --- | --- | ---: |
| `--bg` | `--color-canvas` | 5 |
| `--bg-2` | `--color-surface` | 5 |
| `--bg-3` | `--color-surface-raised` | 34 |
| `--bg-4` | `--color-surface-active` | 8 |
| `--card` | `--color-surface` | 40 |
| `--card-2` | `--color-surface-raised` | 4 |
| `--border` | `--color-border` | 89 |
| `--control-border` | `--color-control-border` | 12 |
| `--line` | `--color-border` | 7 |
| `--line-strong` | `--color-border-strong` | 2 |
| `--ink` | `--color-text` | 61 |
| `--ink-2` | `--color-text-secondary` | 65 |
| `--ink-3` | `--color-text-muted` | 46 |
| `--accent` | `--color-action` | 15 |
| `--accent-2` | `--color-action` | 2 |
| `--accent-3` | `--color-danger` | 10 |
| `--accent-4` | `--color-info` | 0 |
| `--ok` | `--color-success` | 30 |
| `--warn` | `--color-warning` | 22 |
| `--bad` | `--color-danger` | 38 |
| `--info` | `--color-info` | 15 |
| `--focus` | `--color-focus` | 4 |
| `--ok-surface` | `--color-success-surface` | 9 |
| `--warn-surface` | `--color-warning-surface` | 8 |
| `--bad-surface` | `--color-danger-surface` | 10 |
| `--info-surface` | `--color-info-surface` | 5 |
| `--radius` | `--radius-lg` | 1 |
| `--shadow` | `--shadow-1` | 1 |
| `--shadow-soft` | `--shadow-1` | 0 |
| `--max` | `--content-max` | 2 |
| `--gap` | `--space-5` | 3 |

Duplicate canonical targets that the aliases collapsed (7 collisions):
`--color-surface` ← `--bg-2`, `--card`;
`--color-surface-raised` ← `--bg-3`, `--card-2`;
`--color-border` ← `--border`, `--line`;
`--color-action` ← `--accent`, `--accent-2`;
`--color-danger` ← `--accent-3`, `--bad`;
`--color-info` ← `--accent-4`, `--info`;
`--shadow-1` ← `--shadow`, `--shadow-soft`.

### Proven-dead canonicals (6, removed by #400)

Each had zero `var()` uses, zero quoted JS references
(`getPropertyValue` / `setProperty` / string literals) and zero
other-syntax references anywhere in the repo — only its own
definition in `index.html` and a copy of that definition in the
redesign spec. They were deleted from `:root`, and the spec's copy
was replaced by the pointer to this doc.

| Token | Why dead |
| --- | --- |
| `--ease-in-out` | All transitions use `--ease-out` (36 uses). The CSS easing keyword `ease-in-out` in the skeleton-pulse animation is unrelated and untouched. |
| `--space-0` | `0` needs no token; no use. Remaining spacing scale is `--space-1`…`--space-12` minus `--space-7`, `--space-9`, `--space-11`, `--space-13`–`--space-15` (those were never defined). |
| `--space-16` | No use; `--space-12` (48 px) is the largest spacing in use. |
| `--z-base` | No use; base stacking needs no token. |
| `--z-banner` | No use; banners stack via `--z-modal` / normal flow. |
| `--z-overlay` | No use; overlays use `--z-modal` (500). |

Triage named four more "dead" tokens — `--danger`, `--ghost`,
`--secondary`, `--legal` — that were never custom properties at
all: they are BEM class suffixes (`.rc-btn--danger`,
`.account-menu-item--legal`, …) matched by a naive `--name:` regex.
Nothing was deleted for them, and they remain as class names.

### Duplicates / near-duplicates assessed, kept

- `--color-action-hover` (5 uses, `.btn:hover`) vs
  `--color-action-active` (1 use, `.btn:active`): distinct states,
  both used — kept.
- `--color-danger-hover` (1 use, `.btn.danger:hover`): distinct
  state — kept.
- `--shadow-2` (2 uses) / `--shadow-3` (3 uses): distinct
  elevation levels, both used — kept.
- `--color-info-surface` (5 uses after migration) and
  `--content-max` (2 uses after migration): their only pre-#400
  `var()` use was inside an alias definition, so they looked
  near-dead; after migrating `--info-surface` / `--max` they are
  live — kept.
- `--space-*`: every remaining step has 6–180 uses — kept.

## Byte budget

Enforced by `npm run check:byte-budget`
(`scripts/check-byte-budget.mjs`, wired into the deployability CI
job). Basis is file bytes, per the #412 inventory — not network
bytes (`tests/e2e/page-weight.spec.ts` remains the separate
network-view guard and asserts no budget). Thresholds are the #412
proposals, adopted as-is.

| Slice | Threshold | At #400 landing |
| --- | ---: | ---: |
| `index.html` | ≤ 1,000,000 | 977,009 |
| CSS initial (inline `<style>` + stylesheets `index.html` links) | ≤ 130,000 | 127,647 |
| CSS total (inline + all `assets/*.css`) | ≤ 135,000 | 133,836 |
| JS initial (inline `<script>` + `<script src>` assets) | ≤ 1,000,000 | 964,897 |
| JS total (inline + all `assets/*.js`) | ≤ 1,450,000 | 1,409,397 |

CSS total is the tightest slice (1,164 bytes of headroom at
landing): the alias migration itself added bytes, because
canonical names are longer than aliases. A change that pushes any
slice over its threshold must shrink bytes or raise the threshold
with justification in the PR — never silently weaken the check.
