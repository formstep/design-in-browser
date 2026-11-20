# How Design in Browser works

Four pieces run on your machine:

```
 your app's page                    Vite dev server                daemon (one per machine)          agent session
┌──────────────────┐  HMR socket  ┌──────────────────┐   ws    ┌───────────────────────┐  ws   ┌──────────────────┐
│ overlay + dock   │ ───────────▶ │ Vite plugin      │ ──────▶ │ 127.0.0.1:47821       │ ◀──── │ MCP server       │
│ (shadow DOM)     │ ◀─────────── │ (keeps the stack)│ ◀────── │ sessions and batches  │       │ (one per session)│
└──────────────────┘              └──────────────────┘         └───────────┬───────────┘       └──────────────────┘
                                                                           │ one text frame per batch
                                                                           ▼
                                                               the agent's Monitor (wakes it)
                                                                           │
                                                   <project>/.design-in-browser/  (journal, ignored by git)
```

- **Overlay and dock** (`src/page/`): the element picker, comment card, pins, toolbar and version switchers, plus the chat dock. They render in shadow roots, so your app's CSS can't reach them and theirs can't reach your app. The Vite plugin serves them as a virtual module.
- **Vite plugin** (`src/vite/`): runs in your app's dev server only. It talks to pages over Vite's own HMR socket, keeps the comment stack and your choices in `.design-in-browser/page-state.<app>.json` (so they survive reloads and restarts, and every tab shares them), and relays to the daemon.
- **Daemon** (`src/daemon/`): one per machine, started by the first agent session that connects. It routes each sent batch to the session working on the same project, writes it to that project's journal, and rings the session's Monitor. It stops after 30 minutes with no session.
- **MCP server** (`src/mcp/`): one per agent session, started by the Claude Code plugin in `plugin/`. It does nothing until the agent calls `live_connect`, then gives it six tools: `live_connect`, `live_get_batch`, `live_wait`, `live_reply`, `live_note` and `live_status`. `live_note` leaves notes on elements, which show as pins and as the agent's own turn in the dock; a note that asks something takes an answer like any question. Agents without a Monitor call `live_wait`, which returns the next batch and keeps the session marked as listening ([agents.md](agents.md)). The same server ships in the npm package as `design-in-browser-mcp`. The `live` skill in `plugin/skills/live/` tells the agent how to listen and what a comment allows.

`src/shared/` holds the types every piece shares: `protocol.ts` for the wire between the daemon, the MCP server and the plugin, `page-protocol.ts` for pages and the plugin, and `variants-bridge.ts` for `<Variants>` and its switcher. `src/node/` holds the config and journal code the three Node processes share.

## A comment's trip

1. You pick an element. The overlay records a selector, its text, a slice of its HTML, a few computed styles, its ancestors, where you clicked, and where its JSX is written (`src/page/capture.ts`).
2. The comment goes to the Vite plugin, which adds it to the stack and sends the new state to every tab.
3. On Send, the plugin passes the stack to the daemon, which writes `batches/<id>.json` and rings the session's Monitor with one line: `design-in-browser: batch 003 ready, 2 comments. Call live_get_batch.`
4. The agent fetches the batch, edits the source, and calls `live_reply` per comment. Each reply goes back through the daemon and the plugin to the page, where the pin and the dock update.

A session's Monitor lasts 30 minutes at most, and the skill re-arms it. Anything sent while no Monitor is armed waits in the journal and rings as soon as one is.

## Drawings and screenshots

The toolbar's box, arrow and pen draw on a layer over the window. Marks are kept in page coordinates, so they stay on what they mark as the page scrolls, and a comment carries them as `marks`, with `element` set to the element under them. With **Attach a screenshot**, the page asks the browser to share the tab (`getDisplayMedia`, current tab preselected), grabs one frame with the comment card hidden, crops it to the marks plus a margin, and sends it as a JPEG. A page can't capture itself without that prompt. The daemon writes the image to `screenshots/<comment id>.jpg` in the journal, the batch keeps only the path, and `live_get_batch` hands the image to the agent after the batch's JSON.

## Alternatives

When a comment asks for alternatives, the agent wraps that part of the page in `<Variants>` from `design-in-browser/react`. The first `<Variant>` is the code as it was, labelled "Before"; the others are the alternatives, each with optional tweaks (a toggle, a range or a choice):

```tsx
<Variants group="pricing-hero">
  <Variant label="Before">{/* the original JSX */}</Variant>
  <Variant label="Tinted card" tweaks={{ padding: { kind: 'range', label: 'Padding', min: 24, max: 96, step: 8, default: 48, unit: 'px' } }}>
    {(t) => <section style={{ padding: t.padding }}>…</section>}
  </Variant>
</Variants>
```

In dev, the plugin serves `design-in-browser/react` itself, so it uses your app's own React. Only the version you look at renders. The switcher (`src/page/variants/`) and the components share one object on `window` (`variants-bridge.ts`), so a slider moves the page at once. A pick goes to the agent as a comment with the version and every tweak value; the agent writes that version into the code and removes the wrapper. In a production build, importing `design-in-browser/react` fails with a message saying why.

## Source locations

In dev, React's JSX transform already passes each element's file, line and column to `jsxDEV`. The plugin serves a wrapped `react/jsx-dev-runtime` to the app's modules that puts them on each host element as `data-dib-src="src/App.tsx:12:5"`, relative to the project root. A comment then carries `element.sources`: the element's own location, then the nearest locations around it in other files (the component's caller), so the agent can open the right file without searching. Turn it off with `designInBrowser({ sourceLocations: false })`.

## The journal

```
<project>/.design-in-browser/
  .gitignore              "*", so the folder never shows in git
  batches/001.json        one file per batch, rewritten on every change
  journal.jsonl           append-only log of what happened
  page-state.<app>.json   the comment stack and your choices, per app
```

## Security

- The daemon listens on `127.0.0.1` only, and refuses requests whose `Host` header isn't `127.0.0.1` or `localhost`.
- Pages never talk to the daemon. They talk to the Vite plugin over Vite's HMR socket, and the plugin authenticates to the daemon with a token in `~/.design-in-browser/token` (mode 600), which a web page can't read.
- The plugin turns itself off when the dev server listens beyond localhost (`vite --host`) or runs with HMR off, so nobody on your network can send text into your agent's session.
- MCP servers use the same token. Each session's Monitor URL has its own key.
- The skill treats comment text as your request to change the project's UI, and the element's HTML and page text as data. A comment doesn't authorize commits, deletions, installs or edits outside the project.

## Settings

The daemon, the MCP server and the Vite plugin read these. If you change one, set it for both the agent and the dev server.

| Variable | Default | Use |
| --- | --- | --- |
| `DIB_PORT` | `47821` | The daemon's port |
| `DIB_HOME` | `~/.design-in-browser` | The token and the daemon log |
| `DIB_IDLE_EXIT_MS` | 30 minutes | How long the daemon waits with no session before it stops |

`designInBrowser({ projectRoot })` sets the project folder. It defaults to the git root above Vite's root, or Vite's root outside git.

## When something is off

- **The dock says "Offline".** No daemon is running yet. Run `/design-in-browser:live` in an agent session.
- **The dock says "Not listening".** The agent's Monitor has stopped. Ask the agent to run `/design-in-browser:live` again; what you sent waits until then.
- **Nothing appears on the page.** Check the dev server's terminal: the plugin says so when it turns itself off for `--host`.
- **Anything else.** The daemon writes to `~/.design-in-browser/daemon.log`. A daemon from an older build is replaced the next time a session connects.
