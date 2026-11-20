# Using an agent other than Claude Code

Design in Browser talks to agents through an MCP server, so any agent that runs local MCP servers can take comments. Claude Code gets everything from its plugin. For OpenCode and Codex, one command does the same in your project.

## OpenCode

```bash
npx design-in-browser setup opencode
```

It adds the MCP server to `opencode.json` in your project, keeping what is already there, and adds a `/design-in-browser` command to `.opencode/commands/`. Restart OpenCode in the project and run `/design-in-browser`.

If your project uses `opencode.jsonc`, setup leaves it alone, since rewriting it would drop your comments, and prints the entry to add under `"mcp": { "servers": { … } }` yourself.

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

Set the agent's tool timeout to at least 300 seconds, or pass `timeoutSeconds` to `live_wait`. Then give the agent the instructions that setup writes for OpenCode and Codex: they are in [src/setup/listen.md](../src/setup/listen.md).

## How listening works

Claude Code wakes up through its Monitor tool. Other agents call `live_wait`, which returns the next batch as soon as you send one; while the agent waits, the dock shows it as listening. After handling a batch, the agent calls `live_wait` again.

The dock names the agent from the name its MCP client sends. OpenCode and Codex are recognized; any other agent shows as "Agent".

Setup pins the package version it ran with. Run it again after updating to move the agents to the new version.
