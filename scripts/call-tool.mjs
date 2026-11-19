// Calls one bridge tool by hand, as a session of its own on the project. Handy for poking at the
// daemon without Claude Code: it uses the same env (DIB_PORT, DIB_HOME) as the plugin.
// Usage: node scripts/call-tool.mjs <projectRoot> <tool> ['{"json":"args"}']
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'

const [projectRoot, tool, json = '{}'] = process.argv.slice(2)
if (!projectRoot || !tool) {
  console.error('Usage: node scripts/call-tool.mjs <projectRoot> <tool> [json-args]')
  process.exit(2)
}

const client = new Client({ name: 'call-tool', version: '0' })
await client.connect(new StdioClientTransport({ command: process.execPath, args: [new URL('../plugin/dist/mcp.mjs', import.meta.url).pathname], env: process.env }))
const call = async (name, args) => {
  const result = await client.callTool({ name, arguments: args })
  const text = result.content.map((part) => part.text).join('\n')
  if (result.isError) throw new Error(text)
  return text
}
try {
  await call('live_connect', { projectRoot })
  console.log(tool === 'live_connect' ? 'connected' : await call(tool, JSON.parse(json)))
} finally {
  await client.close()
}
