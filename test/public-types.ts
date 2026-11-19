// The published .d.mts files are written by hand. These checks fail the typecheck when they drift from the
// code they describe. Nothing here runs.
import type * as PublicReact from '../src/react/types.d.mts'
import type * as PublicVite from '../src/vite/types.d.mts'
import type { TweakSpec } from '../src/shared/protocol.ts'
import type designInBrowser from '../src/vite/plugin.ts'

type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false
const check = <T extends true>() => undefined as unknown as T

check<Same<PublicReact.TweakSpec, TweakSpec>>()
check<Same<Parameters<typeof PublicVite.default>, Parameters<typeof designInBrowser>>>()
check<Same<ReturnType<typeof PublicVite.default>, ReturnType<typeof designInBrowser>>>()
