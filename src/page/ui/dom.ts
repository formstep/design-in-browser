// Small DOM builders for the page UI. Page text and comment text only ever go in as text, never as HTML;
// `html` is for this package's own icons.
import { icon, type IconName } from '../icons.ts'

type Props = Partial<Pick<HTMLElement, 'className' | 'textContent' | 'title'>> & {
  /** Attributes such as aria-label, role or data-testid. */
  attrs?: Record<string, string>
  /** Markup from this package (icons), never page or comment text. */
  html?: string
}

export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: Props = {},
  children: Array<Node | string> = []
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag)
  const { attrs, html, ...rest } = props
  Object.assign(node, rest)
  for (const [name, value] of Object.entries(attrs ?? {})) node.setAttribute(name, value)
  if (html !== undefined) node.innerHTML = html
  node.append(...children)
  return node
}

/** A `type="button"` button: buttons inside the UI's forms must never submit them by accident. */
export function button(props: Props = {}, children: Array<Node | string> = []): HTMLButtonElement {
  const node = el('button', props, children)
  node.type = 'button'
  return node
}

export function iconNode(name: IconName, size = 16): Element {
  return query(el('span', { html: icon(name, size) }), 'svg')
}

/** The one element matching `selector` in markup this package wrote; a miss is a bug, so it throws. */
export function query<T extends Element>(root: ParentNode, selector: string): T {
  const found = root.querySelector<T>(selector)
  if (!found) throw new Error(`design-in-browser: no ${selector} in its own markup`)
  return found
}
