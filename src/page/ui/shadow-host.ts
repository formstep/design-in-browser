import tokensCss from '../tokens.css'

/**
 * A full-window layer for this package's UI: a custom element on <html> with its own shadow root, so page CSS
 * can't reach it and it can't reach the page. Styles go in as a constructed sheet, not a <style> element, so a
 * page CSP without 'unsafe-inline' can't block them.
 */
export function createShadowHost(tag: string, css: string): { host: HTMLElement; root: ShadowRoot } {
  const host = document.createElement(tag)
  host.style.cssText = 'all: initial; position: fixed; inset: 0; pointer-events: none; z-index: 2147483647;'
  const root = host.attachShadow({ mode: 'open' })
  addStyles(root, tokensCss + css)
  document.documentElement.append(host)
  return { host, root }
}

export function addStyles(root: ShadowRoot, css: string): void {
  const sheet = new CSSStyleSheet()
  sheet.replaceSync(css)
  root.adoptedStyleSheets = [...root.adoptedStyleSheets, sheet]
}
