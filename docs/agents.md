# Using an agent other than Claude Code

Design in Browser talks to agents through an MCP server, so any agent that runs local MCP servers can take comments. Claude Code gets everything from its plugin. For OpenCode and Codex, one command does the same in your project.

## OpenCode

Add the OpenCode plugin from this package:

```bash
opencode plugin add design-in-browser
```

Or run `npx design-in-browser setup opencode` in your project, which adds it to the `plugins` list in `opencode.json`, keeping what is already there.

The plugin adds the MCP server and a `/design-in-browser` command. Restart OpenCode in the project and run `/design-in-browser`. Once the agent has connected, the plugin wakes the session whenever you send comments, as Claude Code's Monitor does, so the agent doesn't have to keep calling `live_wait`.

If your project uses `opencode.jsonc`, setup leaves it alone, since rewriting it would drop your comments, and tells you what to add.

## Codex

```bash
npx design-in-browser setup codex
```

It adds the MCP server to `.codex/config.toml` in your project, with a tool timeout long enough for `live_wait`, and adds a `design-in-browser` skill to `.agents/skills/`. Codex reads a project's config only once you trust the project. Then restart Codex and run `$design-in-browser`.

## Any other agent

Add the server to the agent's MCP settings as a local (stdio) server with this command:

```bash
npx -y -p design-in-browser design-in-browser-mcp
```

Set the agent's tool timeout to at least 300 seconds, or pass `timeoutSeconds` to `live_wait`. Then give the agent the instructions setup writes for Codex: they are in [src/setup/listen.md](../src/setup/listen.md).

## How listening works

Claude Code wakes up through its Monitor tool, and OpenCode through the plugin. Other agents call `live_wait`, which returns the next batch as soon as you send one; while the agent waits, the dock shows it as listening. After handling a batch, the agent calls `live_wait` again.

The dock names the agent from the name its MCP client sends. OpenCode and Codex are recognized; any other agent shows as "Agent".

Setup pins the package version it ran with. Run it again after updating to move the agent to the new version.
