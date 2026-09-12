# The "Functor" Design System — Extracted

*Pulled from `lens/src/styles.css` in `dhernz/Glassbox402`. The stylesheet names itself "Functor design system (colors_and_type.css + app.css)" with `design/dashboard-mockup.html` as the visual source of truth.*

**Styling only.** Drop-in tokens, type scale, and layout rhythm. Nothing here is coupled to x402 or Hedera.

---

## 1. What defines the look

Four decisions carry the entire aesthetic. If you copy nothing else, copy these:

1. **Warm paper, cool ink.** Every background sits at OKLCH hue 85 (warm, yellow-ish). Every text colour sits at hue 280–300 (cool, violet-ish). That opposition is why it reads as paper rather than as grey, and it's invisible until you remove it.
2. **One typeface for everything, including numbers.** No separate monospace family. `--font-mono` is literally aliased to `--font-sans`. Tabular alignment comes from `font-variant-numeric: tabular-nums`, not from a mono font.
3. **A single electric accent on a near-white ground.** One saturated indigo-blue does all the work. Three "brand" hues exist but appear almost nowhere.
4. **One dark object in the whole interface** — the terminal block. It's the only inverted surface, which is exactly why the eye lands on it.

---

## 2. Typography

### Family

```css
@font-face {
  font-family: 'Inter Tight';
  font-style: normal;
  font-weight: 100 900;          /* variable */
  font-display: swap;
  src: url('/InterTight-VariableFont_wght.ttf') format('truetype-variations');
}

--font-sans: 'Inter Tight', system-ui, -apple-system, sans-serif;
--font-mono: var(--font-sans);   /* deliberately the same family */
```

**Inter Tight**, variable weight 100–900, self-hosted. Free on Google Fonts (SIL Open Font License), so you can use it without issue. It's a narrower, tighter-set Inter — the tightness is a meaningful part of the look. Plain Inter will feel noticeably looser.

### The numerals trick

There is no mono font. Numbers stay in Inter Tight and get alignment from OpenType features:

```css
code, .mono, .amt, .addr {
  font-family: var(--font-mono);
  font-variant-numeric: tabular-nums;
  font-feature-settings: 'tnum' 1, 'ss01' 1;
}
```

`tnum` fixes digit widths so columns align. `ss01` is Inter's alternate-digit stylistic set. The result: figures line up like a mono font but stay visually continuous with the prose. This is the single most transferable idea in the system.

### Scale

| Role | Size | Weight | Tracking | Line height |
|---|---|---|---|---|
| Gate / hero title | 34px | 600 | −0.03em | 1.05 |
| Page title | 28px | 600 | −0.02em | 1.1 |
| `h2` | 24px | 600 | −0.02em | 1.2 |
| Stat value | 26px | 600 | −0.01em | — |
| `h3` | 18px | 600 | −0.01em | — |
| Section title | 16px | 600 | — | — |
| Body / `p` | 16px | 400 | — | 1.6 |
| UI default | 15px | 400/500 | — | 1.55 |
| Secondary / table cell | 14px | 400/500 | — | — |
| Label (uppercase) | 13–14px | 500 | **+0.08 to 0.1em** | — |
| Micro note | 11–12px | 400/500 | — | 1.4 |

Two rules run through all of it:

- **Negative tracking above 18px, positive tracking below 14px.** Big text tightens (−0.01 to −0.03em), small uppercase labels open up (+0.08 to +0.1em). Never the reverse.
- **Prose is capped at `max-width: 56ch`** with `text-wrap: pretty`. Line length is controlled at the element, not by the container.

### The label pattern

Used for every section header, stat label and table head:

```css
.section-label {
  font-size: 13px;
  font-weight: 500;
  text-transform: uppercase;
  letter-spacing: 0.1em;
  color: var(--text-tertiary);
}
```

---

## 3. Colour

All values authored in OKLCH. Hex equivalents computed below so you can use them anywhere.

### Backgrounds — warm, hue 85

| Token | OKLCH | Hex | Use |
|---|---|---|---|
| `--bg-primary` | `0.985 0.006 85` | `#fcfaf6` | App ground |
| `--bg-overlay` | `0.995 0.003 85` | `#fefdfb` | Cards — *lighter* than the ground |
| `--bg-surface` | `0.965 0.010 85` | `#f6f3ec` | Sidebar, table headers, hover |
| `--bg-inset` | `0.955 0.008 85` | `#f3f0ea` | Inline code, segmented control track |
| `--bg-elevated` | `0.945 0.012 85` | `#f0ece4` | Nav hover, neutral pills |

Note the inversion: **cards are lighter than the page**, not darker. Elevation reads as light rather than as shadow.

### Text — cool, hue 280–300

| Token | OKLCH | Hex |
|---|---|---|
| `--text-primary` | `0.22 0.015 300` | `#1c1921` |
| `--text-secondary` | `0.36 0.012 280` | `#3c3d43` |
| `--text-tertiary` | `0.52 0.010 280` | `#68686f` |

### Accent — one hue does everything

| Token | OKLCH | Hex |
|---|---|---|
| `--accent` | `0.55 0.22 265` | `#3061ef` |
| `--accent-hover` | `0.48 0.22 265` | `#1e4ad7` |
| `--accent-subtle` | `0.55 0.22 265 / 0.08` | 8% alpha |
| `--accent-surface` | `0.55 0.22 265 / 0.05` | 5% alpha |

The subtle variants are **alpha of the same colour**, never a separately picked pale blue. That's why tinted backgrounds stay in the same family under any surface.

### Semantic — each is a pair

Every state colour has a bright version (dots, borders, fills) and an **ink** version (text on a tinted background), plus a 10%-alpha subtle.

| State | Bright | Hex | Ink | Hex |
|---|---|---|---|---|
| Success | `0.65 0.18 155` | `#00ab62` | `0.45 0.15 155` | `#006738` |
| Warning | `0.75 0.16 80` | `#e1a100` | `0.50 0.14 70` | `#8a5600` |
| Error | `0.58 0.20 25` | `#d73337` | `0.48 0.18 25` | `#ac1922` |

The two-tier pattern is what keeps coloured badges legible. Bright on white fails contrast; ink on a 10% tint passes.

### Borders

| Token | OKLCH | Hex |
|---|---|---|
| `--border` | `0.92 0.008 85` | `#e7e4df` |
| `--border-active` | `0.86 0.010 85` | `#d4d1ca` |

Warm hue 85, same as the backgrounds. Borders are never neutral grey.

### Brand accents — used almost nowhere

| Token | OKLCH | Hex | Where it actually appears |
|---|---|---|---|
| `--brand-lime` | `0.89 0.22 130` | `#a9f63b` | A 5px dot in the logo; CLI flag syntax |
| `--brand-magenta` | `0.65 0.33 330` | `#e800e1` | End of avatar gradients only |
| `--brand-orange` | `0.70 0.22 40` | `#ff682c` | Essentially unused |

They exist to make the restraint elsewhere feel deliberate. Three loud hues, roughly forty pixels of usage. Copy that ratio.

### The terminal — the one dark surface

| Purpose | OKLCH | Hex |
|---|---|---|
| Background | `0.20 0.015 285` | `#15151d` |
| Body text | `0.94 0.01 85` | `#eeebe4` |
| Prompt `$` | `0.62 0.02 285` | `#848592` |
| Flag (`--price`) | brand-lime | `#a9f63b` |
| Value | `0.80 0.14 80` | `#edb345` |
| Wallet address | `0.78 0.14 200` | `#00d0d9` |
| Copy button | `white / 0.08` bg, `white / 0.14` border | — |

Note the dark background is hue 285 — cool, matching the *text* family, not the warm backgrounds. It reads as ink, not as a dimmed page.

---

## 4. Shape, depth and motion

```css
--radius-sm:   8px;    /* buttons, inputs, nav items (7px in places) */
--radius-md:   12px;   /* cards, tables, stats */
--radius-lg:   16px;   /* gate card, hero panels (14px in places) */
--radius-pill: 999px;  /* badges, chips, dots, avatars */

--shadow-sm: 0 1px 3px oklch(0 0 0 / 0.04);
--shadow-md: 0 1px 3px oklch(0 0 0 / 0.04), 0 8px 32px oklch(0 0 0 / 0.06);
--shadow-lg: 0 2px 8px oklch(0 0 0 / 0.06), 0 16px 48px oklch(0 0 0 / 0.10);

--ease-out: cubic-bezier(0.16, 1, 0.3, 1);
```

Shadows are **two-layer**: a 1–2px contact shadow plus a wide, very soft ambient one. Maximum opacity is 10%. Most cards carry no shadow at all — a 1px border does the work.

### The easing curve

`cubic-bezier(0.16, 1, 0.3, 1)` is an expo-out: it moves ~80% of the distance in the first fifth of the duration, then glides. Everything in the interface uses it. Nothing uses `ease`, `linear`, or a spring.

### Duration ladder

| Duration | Applied to |
|---|---|
| 120ms | Hover, focus, all `transition: all` on interactive elements |
| 200ms | Chip state changes, background/border transitions |
| 240ms | View change (`view-in`) |
| 400ms | Bar widths and heights — the only long one |
| 1.1–2s | Pulse loops (live dot, balance bump, row flash) |

### The five animations, in full

```css
/* view enter — the only entrance animation in the app */
@keyframes view-in { from { opacity:0; transform:translateY(4px) } to { opacity:1; transform:translateY(0) } }

/* live indicator — expanding ring, infinite */
@keyframes livepulse {
  0%   { box-shadow: 0 0 0 0 oklch(0.65 0.18 155 / 0.5) }
  70%  { box-shadow: 0 0 0 5px oklch(0.65 0.18 155 / 0) }
  100% { box-shadow: 0 0 0 0 oklch(0.65 0.18 155 / 0) }
}

/* value changed — one-shot ring on the balance pill */
@keyframes bal-pop { /* same shape, 7px, 1.1s */ }

/* new table row arrived — accent tint fading out */
@keyframes rowflash { 0% { background: var(--accent-subtle) } 100% { background: transparent } }

/* listening — scaling ring behind a dot */
@keyframes fp-pulse { 0% { transform: scale(0.7); opacity:.6 } 100% { transform: scale(1.4); opacity:0 } }

/* toast */
@keyframes toast-in { from { transform: translateY(10px); opacity:0 } to { transform: translateY(0); opacity:1 } }
```

Entrance movement is **4px**, toasts 10px. No slide-in-from-far, no scale-up, no stagger.

And the accessibility guard, which is one line:

```css
@media (prefers-reduced-motion: reduce) {
  * { animation-duration: 0.001ms !important; transition-duration: 0.001ms !important; }
}
```

---

## 5. Layout

```
┌──────────┬──────────────────────────────────────────────┐
│ sidebar  │ topbar  56px, border-bottom                  │
│ 248px    ├──────────────────────────────────────────────┤
│ bg-      │ content  padding 32px 40px 64px              │
│ surface  │ ┌────────────────────────────────┐           │
│ border-  │ │ content-inner  max-width 980px │           │
│ right    │ │                                │           │
│          │ └────────────────────────────────┘           │
│ ────     │                                              │
│ footer   │                                              │
│ (wallet) │                                              │
└──────────┴──────────────────────────────────────────────┘
```

| Element | Value |
|---|---|
| Sidebar width | 248px, `--bg-surface`, 1px right border |
| Topbar height | 56px, 0 32px padding, 1px bottom border |
| Content padding | `32px 40px 64px` — extra bottom for scroll comfort |
| Content max-width | **980px**, left-aligned inside the pane |
| Page shell | `height: 100vh; overflow: hidden` — only `.content` scrolls |
| Nav item | 8px 12px, radius 7px, 18px icon, 10px gap |
| Nav group padding | 0 10px (items inset from the rail edge) |
| Card padding | 20px |
| Stat padding | 16px 18px |
| Table row padding | 12px 16px |
| Section margin | 14px below head, 24px below page head |

### Spacing vocabulary

`4 · 6 · 8 · 10 · 12 · 14 · 16 · 20 · 24 · 32 · 40 · 64`

Not a strict 8pt grid. Small gaps (6, 10, 14) appear as often as the round numbers, which is part of why it feels hand-tuned rather than generated.

---

## 6. Component recipes

### Card
```css
background: var(--bg-overlay);      /* lighter than the page */
border: 1px solid var(--border);
border-radius: 12px;
padding: 20px;
/* no shadow by default */
```

### Button

| Variant | Background | Text | Border | Hover |
|---|---|---|---|---|
| Primary | `--accent` | white | none | `--accent-hover` + `translateY(-1px)` |
| Secondary | `--bg-surface` | `--text-primary` | `--border` | `--bg-elevated`, `--border-active` |
| Ghost | transparent | `--accent` | none | `--accent-subtle` |

Base: 15px / 500 / 10px 18px / radius 8px / 16px icon / 6px gap.
Small: 14px / 8px 14px. Large: 16px / 13px 24px / radius 10px.

Only the primary button lifts on hover, and only by 1px.

### Badge
```css
font-size: 14px; font-weight: 500;
padding: 4px 10px; border-radius: 999px;
/* success | warning | error: --{state}-subtle bg + --{state}-ink text */
/* accent: --accent-subtle bg + --accent text */
/* neutral: --bg-elevated bg + --text-secondary text */
```
Optional 5px leading dot using `background: currentColor`.

### Table
```css
.table { border: 1px solid var(--border); border-radius: 12px; overflow: hidden; background: var(--bg-overlay); }
.row   { display: grid; align-items: center; padding: 12px 16px; font-size: 15px; border-top: 1px solid var(--border); }
.row.head { border-top: none; background: var(--bg-surface); font-size: 13px;
            text-transform: uppercase; letter-spacing: 0.08em; color: var(--text-tertiary); }
.row:hover { background: var(--bg-surface); }
```
CSS Grid per row, not `<table>`. Columns declared per table type (e.g. `1.5fr 1fr 96px 96px 150px 78px`) with a `min-width` and a horizontal scroll wrapper. Numeric cells right-aligned with `tabular-nums`.

### Segmented control
```css
.seg     { display: inline-flex; padding: 3px; gap: 2px; background: var(--bg-inset);
           border: 1px solid var(--border); border-radius: 9px; }
.seg-btn { padding: 6px 13px; border-radius: 6px; font-size: 14px; font-weight: 500;
           background: transparent; color: var(--text-secondary); }
.seg-btn.on { background: var(--bg-surface); color: var(--text-primary); box-shadow: var(--shadow-sm); }
```
The active pill is *lighter* than its track and carries the small shadow.

### Empty state
```css
border: 1px dashed var(--border-active);
border-radius: 12px; padding: 40px;
text-align: center; color: var(--text-tertiary); font-size: 15px;
```

### Gate / hero background
```css
background: radial-gradient(120% 90% at 50% 0%, var(--accent-surface) 0%, var(--bg-primary) 55%);
```
A 5%-alpha accent wash from the top. The only gradient on a large surface in the entire app.

### Avatar / identicon
```css
border-radius: 999px;   /* or 6px for small table avatars */
background: linear-gradient(135deg, var(--accent), var(--brand-magenta));
```

### Scrollbar
```css
::-webkit-scrollbar { width: 10px; height: 10px; }
::-webkit-scrollbar-thumb { background: var(--border-active); border-radius: 10px;
                            border: 2px solid var(--bg-primary); }
```
The 2px border in the page colour is what makes the thumb look inset.

---

## 7. Design flow

How a screen is assembled, in order:

1. **Page head** — 28px title, 16px subtitle capped at 60ch, optional action button right-aligned on the baseline.
2. **A hero action card, if the page has one primary thing to do.** Radial accent wash, 14px radius, containing the dark terminal block.
3. **Stat row** — 3–4 stats. Uppercase tracked label, 26px tabular value, small footnote with `.up` / `.down` in success/error ink.
4. **Section head** — 16px/600 title on the left, 15px accent text-button on the right, 14px gap below.
5. **Content** — a table or card group.
6. **Empty states** are dashed, centred, and tell you what to do.

### The interaction grammar

| Meaning | Signal |
|---|---|
| Selected | `--accent-subtle` background + `--accent` text |
| Hoverable | Background lifts one step (`--bg-surface` → `--bg-elevated`) |
| Live | Pulsing ring on a 6–7px dot |
| Just changed | One-shot accent flash that fades out |
| Destructive | Only revealed on hover (border and text shift to error) |
| Numeric | Always `tabular-nums`, always right-aligned in columns |

### Copy voice

Sentence case everywhere except the tracked uppercase micro-labels. Actions are verbs. Tertiary text carries explanation. No exclamation marks in the source.

---

## 8. Drop-in token block

```css
@import url('https://fonts.googleapis.com/css2?family=Inter+Tight:wght@100..900&display=swap');

:root {
  --font-sans: 'Inter Tight', system-ui, -apple-system, sans-serif;
  --font-mono: var(--font-sans);

  --bg-primary:  oklch(0.985 0.006 85);
  --bg-surface:  oklch(0.965 0.010 85);
  --bg-elevated: oklch(0.945 0.012 85);
  --bg-overlay:  oklch(0.995 0.003 85);
  --bg-inset:    oklch(0.955 0.008 85);

  --text-primary:   oklch(0.22 0.015 300);
  --text-secondary: oklch(0.36 0.012 280);
  --text-tertiary:  oklch(0.52 0.010 280);

  --accent:         oklch(0.55 0.22 265);
  --accent-hover:   oklch(0.48 0.22 265);
  --accent-subtle:  oklch(0.55 0.22 265 / 0.08);
  --accent-surface: oklch(0.55 0.22 265 / 0.05);

  --success: oklch(0.65 0.18 155);  --success-ink: oklch(0.45 0.15 155);
  --success-subtle: oklch(0.65 0.18 155 / 0.10);
  --warning: oklch(0.75 0.16 80);   --warning-ink: oklch(0.50 0.14 70);
  --warning-subtle: oklch(0.75 0.16 80 / 0.10);
  --error:   oklch(0.58 0.20 25);   --error-ink:   oklch(0.48 0.18 25);
  --error-subtle:   oklch(0.58 0.20 25 / 0.10);

  --border:        oklch(0.92 0.008 85);
  --border-active: oklch(0.86 0.010 85);

  --brand-lime: oklch(0.89 0.22 130);
  --brand-magenta: oklch(0.65 0.33 330);
  --brand-orange: oklch(0.70 0.22 40);

  --radius-sm: 8px; --radius-md: 12px; --radius-lg: 16px; --radius-pill: 999px;

  --shadow-sm: 0 1px 3px oklch(0 0 0 / 0.04);
  --shadow-md: 0 1px 3px oklch(0 0 0 / 0.04), 0 8px 32px oklch(0 0 0 / 0.06);
  --shadow-lg: 0 2px 8px oklch(0 0 0 / 0.06), 0 16px 48px oklch(0 0 0 / 0.10);

  --ease-out: cubic-bezier(0.16, 1, 0.3, 1);
}

html, body {
  font-family: var(--font-sans);
  background: var(--bg-primary);
  color: var(--text-primary);
  line-height: 1.55;
  -webkit-font-smoothing: antialiased;
  text-rendering: optimizeLegibility;
}

.mono, code, .amt {
  font-family: var(--font-mono);
  font-variant-numeric: tabular-nums;
  font-feature-settings: 'tnum' 1, 'ss01' 1;
}

@media (prefers-reduced-motion: reduce) {
  * { animation-duration: 0.001ms !important; transition-duration: 0.001ms !important; }
}
```

Hex fallbacks for anywhere OKLCH isn't available are in §3.

---

## 9. Notes on reuse

**Licensing.** The repo is MIT, so the CSS is yours to reuse with attribution. Inter Tight is under the SIL Open Font License, also fine — but link it from Google Fonts rather than copying the TTF out of the repo, since that file is 580 KB and unsubset.

**If it's for a project competing in the same space,** change the accent hue and the logo mark at minimum. The structure — warm paper, cool ink, one electric accent, one dark terminal — is a pattern and is fair game. `#3061ef` plus a lime dot in a rounded-square mark is a specific identity and will read as borrowed.

**Three things to keep even if you change everything else:**

1. The warm-background / cool-text hue opposition. It costs nothing and it's why the neutrals look designed.
2. `tabular-nums` + `ss01` instead of a second font family. Cleaner than any mono pairing.
3. The bright/ink pairing on every semantic colour. It's what makes badges readable rather than merely coloured.