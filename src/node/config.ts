import os from 'node:os'
import path from 'node:path'
import { DEFAULT_PORT } from '../shared/protocol.ts'

declare const __BUILD_ID__: string

/** Set by the build so a shim can tell when the running daemon is from an older build. */
export const BUILD_ID = typeof __BUILD_ID__ === 'string' ? __BUILD_ID__ : 'dev'

function readPort(): number {
  const raw = process.env.DIB_PORT
  if (raw === undefined || raw === '') return DEFAULT_PORT
  const port = Number(raw)
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error(`DIB_PORT is not a port: ${raw}`)
  return port
}

export const config = {
  port: readPort(),
  /** Token, daemon log and other per-user state. */
  home: process.env.DIB_HOME ?? path.join(os.homedir(), '.design-in-browser'),
  /** The daemon exits after this long with no session connected. */
  idleExitMs: Number(process.env.DIB_IDLE_EXIT_MS ?? 30 * 60 * 1000),
}

export const tokenPath = () => path.join(config.home, 'token')
export const daemonLogPath = () => path.join(config.home, 'daemon.log')
