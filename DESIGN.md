---
name: upmetrics
description: >-
  GENERATED SEED — extracted from apps/web/src/styles.css. Correct it; do not assume it is right.
colors:
  bg: "#ffffff"
  surface: "#f7f7f6"
  surface-2: "#efeeec"
  border: "#e4e4e1"
  text: "#1a1a18"
  muted: "#6b6b64"
  primary: "#e19468"
  primary-fg: "#1a1a19"
  ok: "#16a34a"
  warn: "#d97706"
  down: "#dc2626"
---
## This file was generated, and it is a starting point

Every value above was read out of `apps/web/src/styles.css` — 11 colour(s). Nothing here was chosen; it is a description of what this repo already looks like, written
down so there is something to correct.

**What to do with it.** Read the palette and delete what is not really part of it — a generated
list cannot tell a brand colour from a one-off. Then write the parts a stylesheet cannot know:
what the page shell is, which header a new route uses, whether buttons are round or square, and
which of these colours means "action" as opposed to "we happened to use it once".

## Why this file matters

`DESIGN.md` is the source a cardmem session is handed at start-up, so a rule written here reaches
the next agent without anyone remembering to open a file. It is also what the drift lint measures
against: a raw colour used where a token above exists becomes a finding rather than a
conversation with the owner.

## Overview

_Replace this with what the product actually looks like, in a sentence or two._

## Anti-patterns

*Applies to every change — these are not per-surface preferences. Each one below has been
shipped, reported by the owner, and fixed; they are here because they came back.*

### The wiggle — the page must NEVER scroll sideways at phone width

Christian's name for it, and he has reported it four times. **Wide content — a table, a
code block, a diagram, a revealed secret — scrolls inside its own `overflow-x: auto`
container. The page body does not move.**

Two traps make it hard to see from a desk:

- **`documentElement.scrollWidth` cannot see it.** Measured on Settings → Secrets: it
  read 393 on a 393px viewport while the content was 588px wide. Assert on element
  right-edges versus `innerWidth`, or on `max(documentElement.scrollWidth, body.scrollWidth)`.
- **A `width: 100%` table cannot shrink below its content's min-width.** One
  `white-space: nowrap` cell therefore sets the width of the whole page.

**What is mechanically checked, and what is not — the half worth knowing.** The Lens DOM
critic raises a `wiggle` finding (severity high, one per run, naming the widest offender)
on any capture at ≤820px **that passes `critic: "dom"`**. A high finding folds the F095
gate to fail, and the auto-review skill passes the critic on every verify — so a card
going THROUGH the gate is covered. **A `lens_capture` you write by hand is not**, because
the daemon's critic default is `off`. Content inside a deliberate horizontal scroller is
not flagged.

So: verify every new surface with a Lens run at phone width **and pass the critic**. Then
the gate tells you instead of the owner's thumb.

### A button label never wraps to a second line

Add `white-space: nowrap`. If it still does not fit, shorten the label — never let it
break. The portal's "Afslut preview" wrapping to two lines is the reported case; it reads
as broken, not as tight.

### No native dialog, and no native form control

`window.alert` / `confirm` / `prompt`, `<select>`, `<input type="date">`, `type="color"`,
`type="range"`. They ignore every token on this page, break dark mode, and render in the
OS's style rather than the product's. Reuse `components/ui/` or build it there. The one
exception is `beforeunload`, which the browser owns.
