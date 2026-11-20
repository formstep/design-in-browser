#!/usr/bin/env node
// `npx design-in-browser setup <agent>`: does for OpenCode or Codex what the Claude Code plugin does, in this
// project: adds the MCP server to the agent's config and an instruction it runs to listen for comments.
import fs from 'node:fs'
import path from 'node:path'
import listen from './listen.md'

declare const __PACKAGE_VERSION__: string

const SERVER = 'design-in-browser'
/** Pinned to this release, so the config keeps working until setup is run again. */
const MCP_COMMAND = ['npx', '-y', '-p', `design-in-browser@${__PACKAGE_VERSION__}`, 'design-in-browser-mcp']
/** live_wait waits 300 s by default; a tool timeout shorter than that ends every wait early. */
const TOOL_TIMEOUT_SEC = 330

const USAGE = `Usage: npx design-in-browser setup <opencode|codex> [--project <dir>]

Sets up design-in-browser for an agent other than Claude Code, in the project folder (default: this one).
Claude Code needs no setup: install its plugin instead (see the README).`

type Written = { file: string; change: 'created' | 'updated' | 'unchanged' }

/** Writes a file unless it already has this content. */
function write(file: string, content: string): Written {
  const before = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null
  if (before === content) return { file, change: 'unchanged' }
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, content)
  return { file, change: before === null ? 'created' : 'updated' }
}

function setupOpenCode(project: string): Written[] {
  if (fs.existsSync(path.join(project, 'opencode.jsonc'))) {
    throw new Error(
      `This project has opencode.jsonc, which setup can't edit without losing its comments. Add this under "mcp": { "servers": { … } } yourself:\n"${SERVER}": ${JSON.stringify({ type: 'local', command: MCP_COMMAND })}`
    )
  }
  const configFile = path.join(project, 'opencode.json')
  const config = fs.existsSync(configFile)
    ? (JSON.parse(fs.readFileSync(configFile, 'utf8')) as Record<string, unknown>)
    : { $schema: 'https://opencode.ai/config.json' }
  const mcp = (config.mcp ?? {}) as { servers?: Record<string, unknown> }
  config.mcp = { ...mcp, servers: { ...mcp.servers, [SERVER]: { type: 'local', command: MCP_COMMAND } } }
  const command = `---\ndescription: Listen for comments from the browser and act on them (design-in-browser)\n---\n\n${listen}`
  return [
    write(configFile, `${JSON.stringify(config, null, 2)}\n`),
    write(path.join(project, '.opencode/commands/design-in-browser.md'), command),
  ]
}

/** The `[mcp_servers.design-in-browser]` table, replacing an earlier one from setup. */
function withCodexServer(toml: string): string {
  const table = [
    `[mcp_servers.${SERVER}]`,
    `command = ${JSON.stringify(MCP_COMMAND[0])}`,
    `args = ${JSON.stringify(MCP_COMMAND.slice(1))}`,
    `tool_timeout_sec = ${TOOL_TIMEOUT_SEC}`,
  ].join('\n')
  // The earlier table runs to the next table header or the end of the file.
  const earlier = new RegExp(`^\\[mcp_servers\\.${SERVER}\\]\\n(?:(?!\\[).*\\n?)*`, 'm')
  if (earlier.test(toml)) return toml.replace(earlier, `${table}\n`)
  return `${toml}${toml === '' || toml.endsWith('\n\n') ? '' : toml.endsWith('\n') ? '\n' : '\n\n'}${table}\n`
}

function setupCodex(project: string): Written[] {
  const configFile = path.join(project, '.codex/config.toml')
  const toml = fs.existsSync(configFile) ? fs.readFileSync(configFile, 'utf8') : ''
  const skill = `---\nname: design-in-browser\ndescription: Listen for comments the user makes on the running app in the browser (design-in-browser) and act on them. Use when the user asks to listen for browser comments.\n---\n\n${listen}`
  return [write(configFile, withCodexServer(toml)), write(path.join(project, '.agents/skills/design-in-browser/SKILL.md'), skill)]
}

const NEXT: Record<string, string> = {
  opencode: 'Restart OpenCode in this project, then run /design-in-browser.',
  codex: 'Trust this project in Codex (it reads .codex/config.toml only then), restart it, then run $design-in-browser.',
}

function main(args: string[]): number {
  const [command, agent] = args
  const projectFlag = args.indexOf('--project')
  const project = path.resolve(projectFlag >= 0 ? (args[projectFlag + 1] ?? '.') : '.')
  if (command !== 'setup' || (agent !== 'opencode' && agent !== 'codex')) {
    console.error(USAGE)
    return 2
  }
  try {
    const written = agent === 'opencode' ? setupOpenCode(project) : setupCodex(project)
    for (const { file, change } of written) console.log(`${change.padEnd(9)} ${path.relative(project, file)}`)
    console.log(NEXT[agent])
    return 0
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    return 1
  }
}

process.exitCode = main(process.argv.slice(2))
