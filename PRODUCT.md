# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

A developer who builds their app with a coding agent and reviews its UI in the browser. The app runs on a local dev server; the agent runs in a terminal beside the browser. Claude Code and OpenCode are supported, and any agent that runs local MCP servers can connect, so the product never assumes one agent.

## Product Purpose

Design in Browser turns UI review into a conversation with the coding agent session that writes the code. The developer comments on the running app itself: picks an element, says what should change, and it goes to the agent on Enter. The agent edits the source, the dev server reloads, and the agent replies to each comment in the browser. Success is a review loop that never leaves the page: point, say what should change, see it change.

## Positioning

Comments are anchored to real elements of the developer's own running app and go straight to the agent session that owns its source, which then edits that source. Nothing is mocked up on a separate canvas and nothing is patched only in the DOM.

## Operating Context

- A Vite plugin in the app's own dev server (dev only): it puts an overlay on the page (picker, comment card, pins) and a dock (comments, sending, replies) into the app's page, and keeps that app's choices.
- A local daemon routes batches to agent sessions and journals every batch in the project's `.design-in-browser` folder. An agent connects through the MCP server; the UI names it from the MCP client name ("Claude", "OpenCode").
- A Claude Code plugin: any running Claude Code session connects with `/design-in-browser:live` and wakes on each batch through a Monitor. An OpenCode plugin wakes OpenCode sessions the same way. Other agents call `live_wait`, which returns the next batch.
- The agent replies per comment with done, a question, or skipped. The developer can answer a question from the panel or from its pin.

## Capabilities and Constraints

- Local dev servers only: localhost, 127.0.0.1, `*.localhost`, `*.test`.
- React and Vite first; other frameworks later.
- Any Claude Code session can connect; no special launch flags. OpenCode gets a plugin too.
- UI copy names the connected agent and falls back to "Agent"; nothing in the UI hard-codes Claude.
- Alternatives (React + Vite): the user asks for 1 to 4 alternatives of a part of the page; the agent builds them in source behind a dev-only `<Variants>` wrapper, the original kept as the first version. The user cycles through them on the page and picks one; the agent then writes the pick into the code and removes the rest. One alternative shows as a Before/After toggle; with more, Before stays one click away beside the pages through the alternatives.
- Tweaks belong to alternatives: each alternative carries knobs the agent chose (a feature on or off, a spacing or size, a choice between options). The user adjusts them live, and the pick carries their final values into the code. Tweaks are not a general property editor.
- Astro sites get an integration (`design-in-browser/astro`) that puts the overlay into Astro's pages. Only React islands carry source locations; `.astro` markup is found by its text.

## Product Principles

- The comment stays on the element: every comment, reply and question is visible where it was made.
- Say it, and it's sent. Every comment, answer and pick goes to the agent as it's made, as its own batch; nothing waits to be sent. Answering a question continues the comment's thread, which stays one pin on the page.
- Try, then decide: alternatives are real code running in the real page, and nothing is final until the user picks.
- Agent-neutral: the look follows Claude Design, the words follow whichever agent is connected.
- The agent changes source, never just the page.
- Nothing is lost: a batch sent while the agent isn't listening waits and rings when it is back.
