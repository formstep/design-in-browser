# Contributing

Thanks for helping.

## Setup

You need Node 24 (see `.nvmrc`) and pnpm 12 (the version in `package.json`'s `packageManager`).

```bash
pnpm install
```

```bash
pnpm build
```

To try your build in an app, link this checkout into it and point Claude Code at the plugin folder:

```bash
pnpm add -D link:/path/to/design-in-browser
```

```bash
claude --plugin-dir /path/to/design-in-browser/plugin
```

For OpenCode, list the checkout's folder in the app's `opencode.json`, as `"plugins": ["/path/to/design-in-browser"]`. OpenCode takes a folder there, not a file such as `dist/opencode.mjs`.

After `pnpm build`, restart the app's dev server for good (stop it and start it again). Vite restarting itself, as on a config change, isn't enough: Node keeps the plugin it already loaded, while the page client is read fresh from disk, and the dock then asks for a restart.

## Commands

| Command | Does |
| --- | --- |
| `pnpm build` | Bundles the daemon and MCP server into `plugin/dist`, and the Vite plugin, page client and React wrapper into `dist` |
| `pnpm check` | Lint (oxlint), format check (oxfmt) and typecheck (after a build, since the test app imports the built package) |
| `pnpm format` | Formats the code |
| `pnpm test` | Builds, then runs the bridge tests: MCP over stdio, the daemon, and a stand-in Vite plugin |
| `pnpm test:e2e` | Builds, then runs Playwright against the React fixture app in `test/e2e/app` and the Astro fixture site in `test/e2e/astro-app` |
| `pnpm capture [dir]` | Screenshots every state of the overlay, dock and switcher, for design review |

Run one browser spec with `pnpm exec playwright test --config test/e2e/playwright.config.ts test/e2e/alternatives.spec.ts`. The first time, install Chromium with `pnpm exec playwright install chromium`.

`node scripts/call-tool.mjs <projectRoot> <tool> '<json args>'` calls one MCP tool by hand, as an agent would.

## Where things are

[docs/architecture.md](docs/architecture.md) explains how the pieces talk. In short:

| Folder | Runs in | Holds |
| --- | --- | --- |
| `src/page/` | the browser | `overlay/` (picker, comment card, pins, toolbar), `dock/`, `variants/` (the switcher), `ui/` (shared DOM helpers), `store.ts` (the page's link to the plugin) |
| `src/vite/` | the dev server | the Vite plugin and `hub.ts`, which keeps the comment stack |
| `src/astro/` | Astro's dev server | the Astro integration, which adds the Vite plugin and puts the client into Astro's pages |
| `src/daemon/` | its own process | `state.ts` (sessions and batches) and `daemon.ts` (sockets) |
| `src/mcp/` | one process per agent session | the MCP server and its daemon client |
| `src/node/` | all three Node processes | config and the journal |
| `src/shared/` | everywhere | the types and contracts between the pieces |
| `src/react/` | your app | `<Variants>` and `<Variant>` |
| `src/opencode/` | OpenCode | the OpenCode plugin (the package's `./server` export) |
| `src/setup/` | the user's shell | `npx design-in-browser setup opencode` |
| `plugin/` | Claude Code | the plugin manifest, the `live` skill and the built MCP server |

## Things to know

- `plugin/dist` is committed, because Claude Code installs the plugin from git. Run `pnpm build` and commit `plugin/dist` with any change to `src/daemon`, `src/mcp`, `src/node` or `src/shared`. CI fails when they don't match. Changes to the page alone don't touch it.
- The page UI is plain DOM. It runs inside other people's apps, so it brings no framework of its own. Put page and comment text in with `textContent` (or `el()` from `src/page/ui/dom.ts`), never `innerHTML`.
- UI copy names the connected agent, from its session, and falls back to "Agent". Never write "Claude" into it.
- [DESIGN.md](DESIGN.md) describes the look and [PRODUCT.md](PRODUCT.md) who it's for. Read them before changing the UI.
- The published `.d.mts` files are written by hand; `test/public-types.ts` fails the typecheck when they drift from the code.

## Releasing

1. Set the new version in `package.json` and `plugin/.claude-plugin/plugin.json`, run `pnpm build`, and commit with `plugin/dist`. Push `main`.
2. Publish from your machine: `npm publish --access public --auth-type=legacy`. It runs `pnpm check` and `pnpm test` first, then asks for a one-time code from your authenticator app. Run `pnpm test:e2e` yourself before, since publishing doesn't.

The `release` workflow (a `v*` tag publishes with trusted publishing) needs a trusted publisher set up on npmjs.com, which this package doesn't have yet, so don't push version tags until it does. Claude Code users get the plugin from `main`.

## Pull requests

- Keep one change per pull request, with tests for new behavior. `pnpm check`, `pnpm test` and `pnpm test:e2e` should pass.
- Write commit messages as [Conventional Commits](https://www.conventionalcommits.org/) with a plain-language subject, such as `fix(dock): keep the answer field while replies arrive`, and a short body saying why.
- For a UI change, include a before and after screenshot (`pnpm capture` helps).
