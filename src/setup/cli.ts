#!/usr/bin/env node
// `npx design-in-browser setup opencode`: does for OpenCode what the Claude Code plugin does, in this project, by
// putting this package's OpenCode plugin in the project's plugins list.
import fs from 'node:fs'
import path from 'node:path'

declare const __PACKAGE_VERSION__: string

const USAGE = `Usage: npx design-in-browser setup opencode [--project <dir>]

Sets up design-in-browser for OpenCode, in the project folder (default: this one).
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

/** The OpenCode plugin in this package brings the MCP server, the command and the wake-up; setup only lists it. */
function setupOpenCode(project: string): Written[] {
  const entry = `design-in-browser@${__PACKAGE_VERSION__}`
  if (fs.existsSync(path.join(project, 'opencode.jsonc'))) {
    throw new Error(
      `This project has opencode.jsonc, which setup can't edit without losing its comments. Add "${entry}" to its "plugins" list, or run: opencode plugin add ${entry}`
    )
  }
  const configFile = path.join(project, 'opencode.json')
  const config = fs.existsSync(configFile)
    ? (JSON.parse(fs.readFileSync(configFile, 'utf8')) as Record<string, unknown>)
    : { $schema: 'https://opencode.ai/config.json' }
  // An earlier pin of this package gives way to this one; every other plugin stays.
  const plugins = (Array.isArray(config.plugins) ? config.plugins : []).filter(
    (plugin) => typeof plugin !== 'string' || !/^design-in-browser(@|$)/.test(plugin)
  )
  config.plugins = [...plugins, entry]
  return [write(configFile, `${JSON.stringify(config, null, 2)}\n`)]
}

function main(args: string[]): number {
  const [command, agent] = args
  const projectFlag = args.indexOf('--project')
  const project = path.resolve(projectFlag >= 0 ? (args[projectFlag + 1] ?? '.') : '.')
  if (command !== 'setup' || agent !== 'opencode') {
    console.error(USAGE)
    return 2
  }
  try {
    for (const { file, change } of setupOpenCode(project)) console.log(`${change.padEnd(9)} ${path.relative(project, file)}`)
    console.log('Restart OpenCode in this project, then run /design-in-browser.')
    return 0
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    return 1
  }
}

process.exitCode = main(process.argv.slice(2))
