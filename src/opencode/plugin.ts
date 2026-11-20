// The OpenCode plugin: what the Claude Code plugin gives Claude Code, for OpenCode. It adds the MCP server from
// this package and a /design-in-browser command, and it wakes the session when comments arrive: once the agent
// has called live_connect, the plugin listens on the session's doorbell socket, as Claude Code's Monitor does,
// and sends each doorbell into the session as a message.
// One default export serves both of OpenCode's plugin APIs: `setup` for V2, `server` for V1 (OpenCode 1.x).
import { fileURLToPath } from 'node:url'
import type { Plugin as V2 } from '@opencode/plugin'
import type { PluginModule as V1 } from '@opencode-ai/plugin'
import WebSocket from 'ws'
import { LISTENER_REPLACED_CLOSE_CODE } from '../shared/protocol.ts'
import listen from './listen.md'

const SERVER = 'design-in-browser'
const DESCRIPTION = 'Listen for comments from the browser and act on them (design-in-browser)'
/** The MCP server this package ships, next to this file once built: dist/opencode.mjs and plugin/dist/mcp.mjs. */
const MCP_SERVER = fileURLToPath(new URL('../plugin/dist/mcp.mjs', import.meta.url))
const MCP_COMMAND = ['node', MCP_SERVER]
const RECONNECT_MS = 2000

/** The listen URL in live_connect's answer, as the Claude Code skill reads it to arm its Monitor. */
export function listenUrlIn(text: string): string | null {
  return /ws:\/\/\S+\/listen\/\S+/.exec(text)?.[0].replace(/,$/, '') ?? null
}

/** The text of a V2 tool result: a string, or text parts. */
function resultText(result: { content?: unknown }): string {
  const { content } = result
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .map((part: unknown) => (typeof part === 'object' && part !== null && 'text' in part && typeof part.text === 'string' ? part.text : ''))
    .join('\n')
}

/**
 * One doorbell socket per OpenCode session that connected, reconnecting after a daemon restart. `prompt` sends a
 * doorbell's text into its session.
 */
function doorbells(prompt: (sessionID: string, text: string) => Promise<unknown>) {
  const sockets = new Map<string, WebSocket>()
  let stopped = false

  function listenFor(sessionID: string, url: string): void {
    sockets.get(sessionID)?.close(1000, 'replaced')
    const socket = new WebSocket(url)
    sockets.set(sessionID, socket)
    // The same words a Monitor event carries; the command's instructions say what to do with them.
    socket.on('message', (data) => void prompt(sessionID, data.toString()).catch(() => {}))
    socket.on('error', () => {})
    socket.on('close', (code) => {
      if (sockets.get(sessionID) !== socket) return
      sockets.delete(sessionID)
      // A newer listener took over, or OpenCode is closing: stay closed. Otherwise the daemon restarted: come back.
      if (stopped || code === LISTENER_REPLACED_CLOSE_CODE) return
      setTimeout(() => {
        if (!stopped && !sockets.has(sessionID)) listenFor(sessionID, url)
      }, RECONNECT_MS)
    })
  }

  return {
    /** After a tool call: when it was live_connect, listen on the session's doorbell. */
    afterTool(tool: string, sessionID: string, output: string): void {
      if (!tool.endsWith('live_connect')) return
      const url = listenUrlIn(output)
      if (url) listenFor(sessionID, url)
    },
    stop(): void {
      stopped = true
      for (const socket of sockets.values()) socket.close(1001, 'OpenCode closing')
      sockets.clear()
    },
  }
}

const setup: V2.Plugin['setup'] = async (ctx) => {
  const bells = doorbells((sessionID, text) => ctx.session.prompt({ sessionID, text }))
  await ctx.mcp.transform((editor) => editor.set(SERVER, { type: 'local', command: MCP_COMMAND }))
  await ctx.command.transform((editor) =>
    editor.add({
      name: SERVER,
      description: DESCRIPTION,
      execute: async ({ sessionID }) => void (await ctx.session.prompt({ sessionID, text: listen })),
    })
  )
  const hook = await ctx.tool.hook('execute.after', (call) => {
    if (call.status === 'completed') bells.afterTool(call.tool, call.sessionID, resultText(call.result))
  })
  return async () => {
    bells.stop()
    await hook.dispose()
  }
}

const server: V1['server'] = async ({ client }) => {
  const bells = doorbells((sessionID, text) =>
    client.session.prompt({ path: { id: sessionID }, body: { parts: [{ type: 'text', text }] } })
  )
  return {
    config: async (config) => {
      config.mcp = { ...config.mcp, [SERVER]: { type: 'local', command: MCP_COMMAND } }
      config.command = { ...config.command, [SERVER]: { template: listen, description: DESCRIPTION } }
    },
    'tool.execute.after': async (input, output) => bells.afterTool(input.tool, input.sessionID, output.output),
    dispose: async () => bells.stop(),
  }
}

const plugin = { id: SERVER, setup, server } satisfies V2.Plugin & V1

export default plugin
