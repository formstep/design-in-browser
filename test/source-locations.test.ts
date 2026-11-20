// Source locations in server-rendered React: the compiled module's jsxDEV is wrapped in place.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { stampJsxInModule } from '../src/vite/plugin.ts'

// What @vitejs/plugin-react hands on for src/Counter.tsx, shortened.
const compiled = [
  'import { useState } from "react";',
  'var _jsxFileName = "/repo/src/Counter.tsx";',
  'import { jsxDEV as _jsxDEV, Fragment as _Fragment } from "react/jsx-dev-runtime";',
  'export function Counter() {',
  '  return /* @__PURE__ */ _jsxDEV("button", { children: "Order" }, void 0, false, { fileName: _jsxFileName, lineNumber: 5, columnNumber: 10 }, this);',
  '}',
].join('\n')

test('the server-side wrapper stamps host elements as the browser does, and keeps every line where it was', () => {
  const stamped = stampJsxInModule(compiled, '/repo')
  assert.ok(stamped)
  assert.equal(stamped.split('\n').length, compiled.split('\n').length)
  assert.match(
    stamped,
    /import \{ jsxDEV as __dibReactJsxDEV, Fragment as _Fragment \} from "react\/jsx-dev-runtime"; const _jsxDEV = function/
  )

  // Run the wrapper against a stand-in for React's jsxDEV.
  const calls: Array<{ type: unknown; props: Record<string, unknown> }> = []
  const wrapperLine = stamped.split('\n')[2]!.replace(/^import [^;]+;/, '')
  const jsxDEV = new Function('__dibReactJsxDEV', `${wrapperLine}; return _jsxDEV`)((type: unknown, props: Record<string, unknown>) =>
    calls.push({ type, props })
  ) as (...args: unknown[]) => void
  const source = (fileName: string) => ({ fileName, lineNumber: 5, columnNumber: 10 })
  jsxDEV('button', { children: 'Order' }, undefined, false, source('/repo/src/Counter.tsx'))
  jsxDEV('div', {}, undefined, false, source('/repo/node_modules/lib/x.js'))
  jsxDEV(function Card() {}, {}, undefined, false, source('/repo/src/Card.tsx'))
  assert.equal(calls[0]!.props['data-dib-src'], 'src/Counter.tsx:5:10')
  assert.equal(calls[1]!.props['data-dib-src'], undefined)
  assert.equal(calls[2]!.props['data-dib-src'], undefined)
})

test('a module without the dev JSX runtime is left alone', () => {
  assert.equal(stampJsxInModule('import { jsx } from "react/jsx-runtime";\n', '/repo'), null)
  assert.equal(stampJsxInModule('import { Fragment } from "react/jsx-dev-runtime";\n', '/repo'), null)
})
