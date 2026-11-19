# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

A developer who builds their app with a coding agent and reviews its UI in Chrome. The app runs on a local dev server; the agent runs in a terminal beside the browser. Claude Code is supported today; OpenCode and other agents are planned, so the product never assumes one agent. The first user is the builder of Formstep, reviewing their own React and Vite apps.

## Product Purpose

Design in Browser turns UI review into a conversation with the coding agent session that writes the code. The developer comments on the running app itself: picks elements, stacks comments across elements and pages, and sends them in one batch. The agent edits the source, the dev server reloads, and the agent replies to each comment in the browser. Success is a review loop that never leaves the page: point, say what should change, see it change.

## Positioning

Comments are anchored to real elements of the developer's own running app and go straight to the agent session that owns its source, which then edits that source. Nothing is mocked up on a separate canvas and nothing is patched only in the DOM.

## Operating Context

- A Chrome extension: an overlay on the page (picker, comment box, pins) and a side panel (comments, sending, replies).
- A local daemon routes batches to agent sessions and journals every batch in the project's `.design-in-browser` folder. An agent connects through the MCP server; the UI names it from the MCP client name ("Claude", "OpenCode").
- A Claude Code plugin: any running Claude Code session connects with `/design-in-browser:live` and wakes on each batch through a Monitor. Other agents need their own connector.
- The agent replies per comment with done, a question, or skipped. The developer can answer a question from the panel or from its pin.

## Capabilities and Constraints

- Local dev servers only: localhost, 127.0.0.1, `*.localhost`, `*.test`.
- React and Vite first; other frameworks later.
- Any Claude Code session can connect; no special launch flags. OpenCode and other agents later.
- UI copy names the connected agent and falls back to "Agent"; nothing in the UI hard-codes Claude.
- Standalone repository, not part of Formstep.
- Next on the roadmap: stamping source locations on elements through a dev-only Vite plugin, then switchable variants that the agent renders from source.
- Open decision: whether a Vite plugin with an in-page dock replaces the Chrome extension.

## Product Principles

- The comment stays on the element: every comment, reply and question is visible where it was made.
- Stack, then send. Comments collect until the developer sends them as one batch.
- Agent-neutral: the look follows Claude Design, the words follow whichever agent is connected.
- The agent changes source, never just the page.
- Nothing is lost: a batch sent while the agent isn't listening waits and rings when it is back.
