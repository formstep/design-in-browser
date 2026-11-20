---
name: Design in Browser
description: A dark canvas look inspired by Claude Design, carried onto a live local app and a chat dock, for any coding agent.
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
  done-ink: "#6fd394"
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
  small:
    fontFamily: "system-ui, -apple-system, Segoe UI, Roboto, sans-serif"
    fontSize: "13px"
    fontWeight: 400
    lineHeight: "18px"
  key:
    fontFamily: "system-ui, -apple-system, Segoe UI, Roboto, sans-serif"
    fontSize: "11px"
    fontWeight: 500
    lineHeight: "18px"
rounded:
  outline: "2px"
  key: "4px"
  check: "5px"
  inner: "6px"
  control: "8px"
  badge: "9px"
  inset: "10px"
  chip: "11px"
  bubble: "12px"
  composer: "14px"
  card: "16px"
  pill: "999px"
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

The overlay and dock are inspired by Claude Design: a dark chrome, a blue selection, comment pins and a comment card, a bottom tool pill with an "Ask <agent>" bar, and a chat for the dock. It is dark only, whatever the system theme. It sits on top of other people's apps, so it stays neutral grey with one blue, and never borrows the host page's styles (everything renders in a shadow root).

Left out on purpose: Anthropic's fonts and logos, the formatting toolbar, the mic, the model picker, and the selection's resize handles (nothing in the overlay resizes, so handles would be a false promise). The UI uses the system sans, and a system serif for the agent's words.

The look takes after Claude Design; the words are not tied to Claude. Every label that names the agent ("@Claude", "Send to Claude", "Ask Claude", "Claude is listening") takes the connected agent's name from its session, so OpenCode shows as "@OpenCode", and falls back to "Agent".

## Colors

### Primary

- **Blue `#257de0`** does every selection and comment job: the hover outline (2px), the selection (the same 2px line, square-cornered, with a 6% blue fill; no handles, since nothing resizes), comment pins, the send button, focus rings and the focus glow. `#6aabf1` on a 12% blue tint is the "@<agent>" chip and the active tool. Small white digits sit on one step darker fills, `#1f6fcb` and `#23824a`, for 4.5:1.

### Neutral

- **Ground `#191919`** behind the dock. **Card `#1f1f1f`** for the comment card, pin threads and the tool pill. **Control `#303030`** for the composer, the Ask bar and the reply fields.
- Text is white at 93%, 62% and 52%. The reference uses 40% for labels; 52% keeps 12px labels at 4.5:1 on the card.

### Named Rules

- **Status lives in the pin's disc.** The pin stays blue; its grey disc shows the draft number, and the disc turns green with a check (done) or amber with a question mark (question). Waiting, skipped and answered pins go grey. Status never relies on hue alone: each has its own glyph.
- **Errors are red text on a red tint**, never blue, so they don't read as selection.
- **Done text is `#6fd394`**, the light step of the done green, for "Done" labels and "Copied" on the card.
- **The working line shimmers.** While the agent works, its status text carries a grey-white gradient sweep, as Claude Design shows it. The sweep is the state, so it runs only with motion on; with reduced motion the text sits still in `ink-3`. It is the one gradient, and the only gradient text.

## Typography

One system sans for everything you do, a serif for everything the agent says, as many chat apps set the assistant's replies. 14/20 in the overlay, 14/21 in the panel, 12px for labels and meta. Selectors in the start command use the system mono.

## Elevation & Depth

Cards: a 4% white inset ring, `0 1px 2px` at 6% and `0 2px 8px` at 24% black. Floating controls (toolbar, tag, Ask bar): an 8% white inset ring and `0 4px 20px` at 30% black. A focused card or field gets a 1px blue ring plus a 6px blue glow, as on Claude Design's comment card. That glow is the one coloured shadow, and it only appears on focus.

## Shapes

Radii step 8 (controls), 12 (bubbles, reply fields), 14 (composer, Ask bar), 16 (cards). Small parts sit below that: 2 on the selection outline, 4 on key hints, 5 on checkboxes, 6 inside a control, 9 on badges, 10 on insets, 11 on chips. The launcher, switches and slider thumbs are full pills. The pin is a drop: three round corners and a sharp bottom-left corner that sits on the clicked point. The same shape, at 18px, numbers comments in the panel and links each of Claude's replies to its comment.

## Components

- **Comment card:** 300px, beside the pin at the clicked point. A muted line naming the element, the "@<agent>" chip on the first line of the text, "Send to <agent>" (off by default: comments stack until sent) and an Enter hint.
- **Pin thread:** opens on click, hover or focus. You, then the agent in the serif, then an "Answer <agent>" field when the agent asked something.
- **Tool pill:** bottom centre while picking. Comment tool, the box, arrow and pen drawing tools (the one in use on a blue tint), comment count, "Ask <agent>" (a page note in a bar above it) and Done.
- **Marks:** boxes, arrows and pen strokes in the selection blue, 2.5px with round ends; a box takes the selection's faint fill. Marks of comments already in the stack stay drawn at 55% opacity. The comment card opens at the top-right corner of a drawing, with an "Attach a screenshot" row above its foot.
- **Agent notes:** a pin whose disc carries the comment glyph; its thread shows the agent's words alone. In the dock, notes are the agent's own turn, under "Notes from <agent>".
- **Dock:** opens from a launcher in the bottom-right corner (Alt+Shift+D) on the right of the page, 380px wide. A 44px header with the project, a listening dot and a close button; a chat thread where each batch is your bubble and the agent's numbered replies follow; a composer holding stacked comments like attachments, a message field and a send button.

- **Version switcher:** a dark bar (#1f1f1f, 36px, radius 12, floating shadow) in the first spot that covers none of the page's text, media or controls: above the `<Variants>` group's top-left, inside its top-right corner, then below it; with none free, inside the corner. The group name in muted text with a layers icon, then: with one alternative a "Before | After" segmented toggle; with more, a "Before | <alternative's label>" toggle, then arrows and "1 / 2" over the alternatives (the count muted while Before shows). Tweaks (blue tint when open) and **Use this** / **Keep after** / **Keep before** (white on `#1f6fcb`) join on hover or focus. After a pick it reads "Picked “…” · waiting for <agent>" until the agent applies it. It is placed at its full width, so the controls joining on hover never push it onto content or under the dock, and it holds still while the pointer or keyboard focus is in it, or its tweaks card is open: each version has its own shape, and flipping Before and After must not move the buttons.
- **Tweaks card:** the comment card's surface, 300px, opened where it hides none of the group it tweaks: beside the group, under or over the switcher, in the group's right corners or below it, else where it hides the least of the group; one row per tweak, label left in `ink-2`, control right: a blue switch for toggles, a blue slider with its value for ranges, a segmented control for choices. The row layout follows Claude Design's Tweaks panel; the switch and slider are derived, since that panel showed only text and select fields.
- **Comment card modes:** "Comment" and "Alternatives" tabs at the top; Alternatives adds a 1 to 4 segmented count.

## Do's and Don'ts

- Do keep the overlay's styles in the constructed sheet: page security policies block `<style>` tags.
- Do put page text in with `textContent` only.
- Don't add a light theme without measuring Claude's.
- Don't show controls that do nothing: no formatting toolbar, no mic.
- Don't make "Send to <agent>" the default: stack-then-send is the core flow.
- Don't write "Claude" into UI copy: name the session's agent. "In Claude Code, run …" is fine where the step really is Claude Code's.
