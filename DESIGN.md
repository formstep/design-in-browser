---
name: Design in Browser
description: Claude Design's dark canvas chrome, carried onto a live local app and a chat dock, for any coding agent.
colors:
  ground: "#191919"
  card: "#1f1f1f"
  control: "#303030"
  control-hover: "#3a3a3a"
  ink: "rgba(255, 255, 255, 0.93)"
  ink-2: "rgba(255, 255, 255, 0.62)"
  ink-3: "rgba(255, 255, 255, 0.52)"
  blue: "#257de0"
  blue-ink: "#6aabf1"
  blue-tint: "rgba(37, 125, 224, 0.12)"
  disc: "#454545"
  done: "#2f9e5b"
  question: "#e3a33b"
  listening: "#3fb950"
  danger-ink: "#ff8f8f"
typography:
  ui:
    fontFamily: "system-ui, -apple-system, Segoe UI, Roboto, sans-serif"
    fontSize: "14px"
    fontWeight: 400
    lineHeight: "20px"
  claude:
    fontFamily: "ui-serif, New York, Iowan Old Style, Georgia, serif"
    fontSize: "15px"
    fontWeight: 400
    lineHeight: "22px"
  label:
    fontFamily: "system-ui, -apple-system, Segoe UI, Roboto, sans-serif"
    fontSize: "12px"
    fontWeight: 400
    lineHeight: "17px"
rounded:
  control: "8px"
  bubble: "12px"
  composer: "14px"
  card: "16px"
  chip: "11px"
spacing:
  xs: "4px"
  sm: "8px"
  md: "12px"
  lg: "16px"
components:
  comment-card:
    backgroundColor: "{colors.card}"
    rounded: "{rounded.card}"
    padding: "12px 14px"
    width: "300px"
  composer:
    backgroundColor: "{colors.control}"
    rounded: "{rounded.composer}"
    padding: "8px"
  bubble:
    backgroundColor: "rgba(255, 255, 255, 0.05)"
    rounded: "{rounded.bubble}"
    padding: "10px 14px"
  chip-agent:
    backgroundColor: "{colors.blue-tint}"
    textColor: "{colors.blue-ink}"
    rounded: "{rounded.chip}"
    padding: "0 7px"
  pin:
    backgroundColor: "{colors.blue}"
    size: "32px"
  send:
    backgroundColor: "{colors.blue}"
    textColor: "#ffffff"
    rounded: "{rounded.control}"
    size: "28px"
---

# Design System: Design in Browser

## Overview

The overlay and dock copy Claude Design, at the user's request: its dark chrome, its blue selection, its comment pins and comment card, its bottom tool pill and "Ask Claude" bar, and claude.ai's chat for the dock. Values were measured from claude.ai on 2026-11-19 (computed styles where readable, pixel samples elsewhere). It is dark only, whatever the system theme. It sits on top of other people's apps, so it stays neutral grey with one blue, and never borrows the host page's styles (everything renders in a shadow root).

Not copied: Anthropic's fonts and logos, the formatting toolbar, the mic, the model picker, and the selection's resize handles (nothing in the overlay resizes, so handles would be a false promise). The UI uses the system sans, and a system serif for the agent's words.

The look is Claude Design's; the words are not tied to Claude. Every label that names the agent ("@Claude", "Send to Claude", "Ask Claude", "Claude is listening") takes the connected agent's name from its session, so OpenCode shows as "@OpenCode", and falls back to "Agent".

## Colors

### Primary

- **Blue `#257de0`** does every selection and comment job: the hover outline (2px), the selection (the same 2px line, square-cornered, with a 6% blue fill; no handles, since nothing resizes), comment pins, the send button, focus rings and the focus glow. `#6aabf1` on a 12% blue tint is the "@<agent>" chip and the active tool. Small white digits sit on one step darker fills, `#1f6fcb` and `#23824a`, for 4.5:1.

### Neutral

- **Ground `#191919`** behind the dock. **Card `#1f1f1f`** for the comment card, pin threads and the tool pill. **Control `#303030`** for the composer, the Ask bar and the reply fields.
- Text is white at 93%, 62% and 52%. The reference uses 40% for labels; 52% keeps 12px labels at 4.5:1 on the card.

### Named Rules

- **Status lives in the pin's disc.** The pin stays blue; its grey disc shows the draft number, and the disc turns green with a check (done) or amber with a question mark (question). Waiting, skipped and answered pins go grey. Status never relies on hue alone: each has its own glyph.
- **Errors are red text on a red tint**, never blue, so they don't read as selection.

## Typography

One system sans for everything you do, a serif for everything the agent says (as claude.ai sets Claude's replies). 14/20 in the overlay, 14/21 in the panel, 12px for labels and meta. Selectors in the start command use the system mono.

## Elevation & Depth

Cards: a 4% white inset ring, `0 1px 2px` at 6% and `0 2px 8px` at 24% black. Floating controls (toolbar, tag, Ask bar): an 8% white inset ring and `0 4px 20px` at 30% black. A focused card or field gets a 1px blue ring plus a 6px blue glow, copied from Claude Design's comment card. That glow is the one coloured shadow, and it only appears on focus.

## Shapes

Radii step 8 (controls), 12 (bubbles, reply fields), 14 (composer, Ask bar), 16 (cards). The pin is a drop: three round corners and a sharp bottom-left corner that sits on the clicked point. The same shape, at 18px, numbers comments in the panel and links each of Claude's replies to its comment.

## Components

- **Comment card:** 300px, beside the pin at the clicked point. A muted line naming the element, the "@<agent>" chip on the first line of the text, "Send to <agent>" (off by default: comments stack until sent) and an Enter hint.
- **Pin thread:** opens on click, hover or focus. You, then the agent in the serif, then an "Answer <agent>" field when the agent asked something.
- **Tool pill:** bottom centre while picking. Comment tool, comment count, "Ask <agent>" (a page note in a bar above it) and Done.
- **Dock:** opens from a launcher in the bottom-right corner (Alt+Shift+D) on the right of the page, 380px wide. A 44px header with the project, a listening dot and a close button; a chat thread where each batch is your bubble and the agent's numbered replies follow; a composer holding stacked comments like attachments, a message field and a send button.

## Do's and Don'ts

- Do keep the overlay's styles in the constructed sheet: page security policies block `<style>` tags.
- Do put page text in with `textContent` only.
- Don't add a light theme without measuring Claude's.
- Don't show controls that do nothing: no formatting toolbar, no mic.
- Don't make "Send to <agent>" the default: stack-then-send is the core flow.
- Don't write "Claude" into UI copy: name the session's agent. "In Claude Code, run …" is fine where the step really is Claude Code's.
