---
version: 1
slug: "extension"
primary_target: "extension"
related_targets: ["src/extension"]
---

Mode: Operate. The developer is mid-review, eyes on their own app; the extension is a tool around it.

## Direction contract

THESIS: Review the live app the way Claude Design reviews a canvas: pin a comment on the thing, talk to the coding agent in a chat. Agent-neutral: the look is Claude Design's, every label names the connected agent (Claude, OpenCode) and falls back to "Agent". Refuses the issue-tracker panel of cards, chips and status badges.

OWN-WORLD: Claude Design's dark chrome, measured: ground #191919, cards #1f1f1f with a 4% white inset ring, controls and composer #303030 with an 8% ring, radius 16 cards, 14 composer, 12 bubbles. One blue, #257de0, for selection outline, square handles, comment pins (three round corners, one sharp at the click point, grey #454545 disc inside), focus glow and the "@<agent>" chip (#6aabf1 on 12% blue). System sans for UI; a serif for the agent's words, as claude.ai sets replies.

STORY: The developer points at an element, types, stacks comments, sends; the panel reads as a conversation where the agent answers each comment and asks when unsure.

FIRST VIEWPORT: Side panel: header with project and listening dot; chat thread filling the middle; composer pinned at the bottom holding stacked comments above the message field, Send at its corner. Page: bottom-centre tool pill while picking; the selected element keeps the 2px blue line with a faint fill and no resize handles (nothing resizes).

FORM: pinned by the user ("copy claude design chat, annotation, popup, highlighting etc."), so the concept roll was skipped and no seed reference exists for this brief.

FINISH: unreviewed and undocumented is unfinished; this build ends with the finish review, the verdict, DESIGN.md, and every shipping raster carrying its provenance
