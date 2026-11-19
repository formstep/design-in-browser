---
version: 1
slug: "page-ui"
primary_target: "page-ui"
related_targets: ["src/page"]
---

Mode: Operate. The developer is mid-review, eyes on their own app; the overlay and dock are a tool around it.

## Direction contract

THESIS: Review the live app the way a design canvas reviews a mockup, inspired by Claude Design: pin a comment on the thing, talk to the coding agent in a chat. Agent-neutral: the look takes after Claude Design, every label names the connected agent (Claude, OpenCode) and falls back to "Agent". Refuses the issue-tracker panel of cards, chips and status badges.

OWN-WORLD: a dark chrome inspired by Claude Design: ground #191919, cards #1f1f1f with a 4% white inset ring, controls and composer #303030 with an 8% ring, radius 16 cards, 14 composer, 12 bubbles. One blue, #257de0, for selection outline, comment pins (three round corners, one sharp at the click point, grey #454545 disc inside), focus glow and the "@<agent>" chip (#6aabf1 on 12% blue). System sans for UI; a serif for the agent's words, as claude.ai sets replies.

STORY: The developer points at an element, types, stacks comments, sends; the panel reads as a conversation where the agent answers each comment and asks when unsure.

FIRST VIEWPORT: Dock: header with project and listening dot; chat thread filling the middle; composer pinned at the bottom holding stacked comments above the message field, Send at its corner. Page: bottom-centre tool pill while picking; the selected element keeps the 2px blue line with a faint fill and no resize handles (nothing resizes).

FORM: pinned by the user (a chat, annotation, popup and highlighting inspired by Claude Design), so the concept roll was skipped and no seed reference exists for this brief.

FINISH: unreviewed and undocumented is unfinished; this build ends with the finish review, the verdict, DESIGN.md, and every shipping raster carrying its provenance
