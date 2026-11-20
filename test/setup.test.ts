// `npx design-in-browser setup <agent>`, run as the built CLI against scratch projects.
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'

const cli = path.resolve(import.meta.dirname, '../dist/cli.mjs')
const { version } = JSON.parse(fs.readFileSync(path.resolve(import.meta.dirname, '../package.json'), 'utf8')) as { version: string }

function scratch(files: Record<string, string> = {}): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dib-setup-'))
  for (const [name, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, name)), { recursive: true })
    fs.writeFileSync(path.join(dir, name), content)
  }
  return dir
}

const run = (...args: string[]) => spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8' })
const read = (dir: string, file: string) => fs.readFileSync(path.join(dir, file), 'utf8')

test('setup opencode lists the plugin in opencode.json, keeps the rest, and replaces an earlier pin', () => {
  const project = scratch({ 'opencode.json': JSON.stringify({ theme: 'dark', plugins: ['opencode-other', 'design-in-browser@0.0.1'] }) })
  const first = run('setup', 'opencode', '--project', project)
  assert.equal(first.status, 0, first.stderr)
  const config = JSON.parse(read(project, 'opencode.json'))
  assert.equal(config.theme, 'dark')
  assert.deepEqual(config.plugins, ['opencode-other', `design-in-browser@${version}`])
  // The plugin brings the server and the command itself.
  assert.equal(config.mcp, undefined)
  assert.equal(fs.existsSync(path.join(project, '.opencode/commands')), false)
  // Again: nothing changes.
  assert.match(run('setup', 'opencode', '--project', project).stdout, /unchanged opencode\.json/)
})

test('setup opencode leaves opencode.jsonc alone and prints what to add', () => {
  const project = scratch({ 'opencode.jsonc': '// mine\n{}\n' })
  const result = run('setup', 'opencode', '--project', project)
  assert.equal(result.status, 1)
  assert.match(result.stderr, /opencode\.jsonc/)
  assert.equal(read(project, 'opencode.jsonc'), '// mine\n{}\n')
})

test('setup codex adds its server table once, with a tool timeout longer than a wait, and a skill', () => {
  const project = scratch({
    '.codex/config.toml': 'model = "o3"\n\n[mcp_servers.design-in-browser]\ncommand = "old"\n\n[mcp_servers.other]\ncommand = "x"\n',
  })
  assert.equal(run('setup', 'codex', '--project', project).status, 0)
  assert.equal(run('setup', 'codex', '--project', project).status, 0)
  const toml = read(project, '.codex/config.toml')
  assert.equal(toml.match(/\[mcp_servers\.design-in-browser\]/g)?.length, 1)
  assert.match(toml, /\[mcp_servers\.other\]\ncommand = "x"/)
  assert.match(toml, /model = "o3"/)
  assert.match(
    toml,
    new RegExp(
      `args = \\["-y","-p","design-in-browser@${version.replaceAll('.', '\\.')}","design-in-browser-mcp"\\]\\ntool_timeout_sec = 330`
    )
  )
  assert.match(read(project, '.agents/skills/design-in-browser/SKILL.md'), /^---\nname: design-in-browser\ndescription: .+\n---\n/)
})

test('setup with no agent explains itself and fails', () => {
  const result = run('setup')
  assert.equal(result.status, 2)
  assert.match(result.stderr, /Usage: npx design-in-browser setup <opencode\|codex>/)
})
