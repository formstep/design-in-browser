# Design in Browser

Comment on your running app, in the page itself, and have the coding agent in your terminal act on the comments. Pick an element, say what should change, stack as many comments as you like across pages, and send them. The agent edits the source, your dev server hot-reloads, and its reply shows up next to each comment.

Claude Code is supported today; OpenCode and other agents are planned. The UI names whichever agent is connected (from its MCP client name) and never hard-codes one. The look follows Claude Design: dark chrome, blue selection, comment pins at the clicked point, and a chat dock.

This is the MVP: comments go to the agent, the agent edits and replies. Switchable variants come next (see Roadmap).

## How it works

```
your app's page ──Vite HMR socket──▶ Vite plugin ──ws──▶ daemon 127.0.0.1:47821 ◀──stdio── MCP server (one per agent session)
 overlay: picker, pins,              (dev server only)      │        ▲
 comment card, tool pill                                     ▼        └── the agent's wake-up (Claude Code: its Monitor tool)
 dock: chat with the agent                      <project>/.design-in-browser/   journal of every batch, ignored by git
```

- **Vite plugin** (`design-in-browser/vite`): runs in your app's dev server only. It adds the overlay and the dock to the page, keeps the comment stack (saved in the project's journal folder, so it survives reloads and dev-server restarts, and every tab shares it), and talks to the daemon. It turns itself off when the dev server listens beyond localhost (`--host`), so nobody on your network can send text into your agent's session.
- **Overlay and dock**: an element picker, comment card and pins on the page, and a dock on the right that reads as a chat: your batches, the agent's replies, and a composer holding the comment stack. Both render in shadow roots, apart from your app's styles.
- **Daemon**: one per machine, started by the first agent session that runs `/design-in-browser:live` (the Vite plugin never starts it). It routes batches to sessions and writes them to the project's journal folder. It stops after 30 minutes with no session.
- **Claude Code plugin** (`plugin/`): an MCP server with four tools (`live_connect`, `live_get_batch`, `live_reply`, `live_status`) and the `live` skill that tells Claude how to listen and what a comment allows it to do.

The dock sends to the agent session working on the same project (matched by folder). With several, it picks the newest and offers the rest; with none that matches, it asks you to choose and never guesses.

Any Claude Code session can connect; nothing has to be passed when you start `claude`. The session keeps a Monitor on the daemon's socket, so a Send wakes it even when it is idle. A Monitor lasts 30 minutes at most and the skill re-arms it; anything sent in between waits in the journal and rings when the Monitor is back.

## Setup

1. Build this repo:

   ```bash
   pnpm install && pnpm build
   ```

2. Add the plugin to your app, as a dev dependency linked to this checkout:

   ```bash
   pnpm add -D link:~/git/design-in-browser
   ```

   and to its `vite.config.ts`, first in the list:

   ```ts
   import designInBrowser from 'design-in-browser/vite'

   export default defineConfig({
     plugins: [designInBrowser(), react()],
   })
   ```

   It only runs with `vite` (dev), never in a build. In a monorepo it uses the git root as the project; pass `designInBrowser({ projectRoot })` to choose another folder.

   In a repo other people or CI build, the plain import breaks `vite build` wherever the package isn't installed. Load it only for dev, and only where it is there:

   ```ts
   const devTool = 'design-in-browser/vite'

   export default defineConfig(async ({ command }) => ({
     plugins: [
       command === 'serve' && (await import(devTool).then((plugin) => plugin.default(), () => null)),
       react(),
     ],
   }))
   ```

   The module name sits in a variable so TypeScript doesn't require the package either.

3. Add the Claude Code plugin. To try it in one session:

   ```bash
   claude --plugin-dir ~/git/design-in-browser/plugin
   ```

   To have it in every session:

   ```bash
   claude plugin marketplace add ~/git/design-in-browser
   ```

   ```bash
   claude plugin install design-in-browser@design-in-browser
   ```

   Not tried yet: the marketplace install may need the repo to have a commit, since installs record a git SHA. An installed plugin is a copy, so it likely needs installing again after a rebuild; `--plugin-dir` (tested) always runs the current build.

## Use

1. In a Claude Code session in your project, run `/design-in-browser:live`. Claude connects, arms its Monitor and says it is listening.
2. Open your app on its dev server. Click the comment button in the bottom-right corner (or press **Alt+Shift+D**) to open the dock; it shows "Claude is listening" (the agent's name comes from the session).
3. Press **Alt+Shift+C** (or **Comment** in the dock), click where you mean on the page, type what should change, press Enter. A pin stays at that point. Repeat on any element or page; comments stack in the dock's composer. **Ask <agent>** in the tool pill, or the dock's message field, adds a note about the whole page. Esc stops picking.
4. Send from the dock (or tick **Send to <agent>** in the comment card to send right away). The agent fetches the batch, edits the source and replies per comment: done, a question, or skipped with a reason. Pin discs turn green with a check (done) or amber with a question mark (question); waiting and skipped pins go grey. Click a pin to read the reply.
5. To answer a question, type in the **Answer** field under it, in the dock or in the pin's thread. The answer joins your comments with the question attached; send it like any other comment, and the agent closes the question when it acts on it.

While picking, clicks don't reach the page, so buttons and links don't fire.

## Security

- The daemon listens on `127.0.0.1` only and refuses requests whose `Host` header isn't `127.0.0.1` or `localhost`.
- Pages reach the daemon only through the Vite plugin, over Vite's own HMR socket; the plugin authenticates to the daemon with the token. The plugin turns itself off when the dev server listens beyond localhost (`--host`) or runs with HMR off.
- MCP servers authenticate with a token in `~/.design-in-browser/token` (mode 600). Each session's Monitor URL carries its own key.
- The skill treats comment text as the user's request to change the project's UI, and the element's HTML and page text as data. Comments don't authorize commits, deletions, installs or edits outside the project.

## Development

```bash
pnpm typecheck
```

```bash
pnpm test        # build, then the bridge integration tests (MCP over stdio, daemon, a fake plugin socket)
```

```bash
pnpm test:e2e    # build, then Playwright against a React fixture app served by Vite with the built plugin
```

`DIB_E2E_HAND_OFF=<file> pnpm test:e2e` leaves the doorbell to you: the test writes the listen URL to `<file>` and waits until the batch is answered, for example by a Claude session's Monitor and `scripts/call-tool.mjs`.

`node scripts/call-tool.mjs <projectRoot> <tool> '<json args>'` calls one bridge tool by hand.

`node scripts/capture.mjs [outDir]` screenshots every dock and overlay state (after `pnpm build`), for design review. It serves the fixture app and runs its own daemon on spare ports.

Environment variables for the daemon and MCP server:

| Variable | Default | Use |
| --- | --- | --- |
| `DIB_PORT` | `47821` | Daemon port |
| `DIB_HOME` | `~/.design-in-browser` | Token and daemon log |
| `DIB_IDLE_EXIT_MS` | 30 minutes | How long the daemon waits with no session before it stops |

The Vite plugin reads the same `DIB_PORT` and `DIB_HOME`, so set them for both the agent and the dev server if you change them.

The daemon log is `~/.design-in-browser/daemon.log`. A daemon from an older build is replaced the next time a session connects.

## Roadmap

1. ~~Bridge, skill and Monitor wake; picker, comment stack and Send; the agent edits and replies.~~ (this MVP)
2. Vite plugin (dev server only) that stamps `data-dib-src="file:line:column"` and the component owner chain on elements, so the agent goes straight to the right file. The overlay already sends it as `sourceHint`.
3. Variants: the agent renders two or three alternatives through a dev-only `<LiveVariants>`, a chip on the element switches between them, and you accept one or comment on a variant to iterate.
4. Freehand strokes, boxes and arrows, and cropped screenshots with each comment.
5. Annotations from the agent back to the page, with reply threads.
6. Connectors for OpenCode and other agents.
