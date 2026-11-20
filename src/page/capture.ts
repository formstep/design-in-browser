// What the page records about a picked element, so the agent can find it in the source.
import { SOURCE_ATTRIBUTE } from '../shared/page-protocol.ts'
import type { ElementRef, PageRef } from '../shared/protocol.ts'

const STYLE_KEYS = [
  'display',
  'position',
  'width',
  'height',
  'margin',
  'padding',
  'gap',
  'color',
  'background-color',
  'font-family',
  'font-size',
  'font-weight',
  'line-height',
  'border',
  'border-radius',
  'box-shadow',
] as const

const HTML_LIMIT = 4000

const isUnique = (selector: string) => {
  try {
    return document.querySelectorAll(selector).length === 1
  } catch {
    return false
  }
}

function step(element: Element): string {
  const tag = element.localName
  const testId = element.getAttribute('data-testid')
  if (testId) return `${tag}[data-testid="${CSS.escape(testId)}"]`
  if (element.id) return `#${CSS.escape(element.id)}`
  const parent = element.parentElement
  if (!parent) return tag
  const sameTag = [...parent.children].filter((child) => child.localName === tag)
  return sameTag.length === 1 ? tag : `${tag}:nth-of-type(${sameTag.indexOf(element) + 1})`
}

/** Shortest chain of steps from the element up that matches only this element. */
export function buildSelector(element: Element): string {
  const parts: string[] = []
  let current: Element | null = element
  while (current && current !== document.documentElement) {
    parts.unshift(step(current))
    const selector = parts.join(' > ')
    if (isUnique(selector)) return selector
    current = current.parentElement
  }
  return parts.join(' > ')
}

/** `button.primary.large` style label, for people and for the agent. */
export function label(element: Element): string {
  const classes = [...element.classList]
    .slice(0, 3)
    .map((name) => `.${name}`)
    .join('')
  const id = element.id ? `#${element.id}` : ''
  return `${element.localName}${id}${classes}`
}

const collapse = (value: string) => value.replace(/\s+/g, ' ').trim()

export function captureElement(element: Element): ElementRef {
  const box = element.getBoundingClientRect()
  const computed = getComputedStyle(element)
  const styles: Record<string, string> = {}
  for (const key of STYLE_KEYS) styles[key] = computed.getPropertyValue(key)

  const ancestors: string[] = []
  for (let parent = element.parentElement; parent && ancestors.length < 4; parent = parent.parentElement) {
    if (parent === document.body) break
    ancestors.push(label(parent))
  }

  // The source attributes are in `sources`; in the HTML they are noise.
  const html = element.outerHTML.replaceAll(new RegExp(` ${SOURCE_ATTRIBUTE}="[^"]*"`, 'g'), '')
  return {
    selector: buildSelector(element),
    tag: element.localName,
    id: element.id || null,
    classes: [...element.classList],
    text: collapse(element.textContent ?? '').slice(0, 120),
    html: html.length > HTML_LIMIT ? `${html.slice(0, HTML_LIMIT)}<!-- cut, ${html.length} chars in all -->` : html,
    rect: { x: box.x + scrollX, y: box.y + scrollY, width: box.width, height: box.height },
    styles,
    ancestors,
    sources: sourcesOf(element),
  }
}

/** The element's own source location, then the nearest ones around it in other files: at most three. */
function sourcesOf(element: Element): string[] {
  const sources: string[] = []
  const files = new Set<string>()
  for (
    let node = element.closest(`[${SOURCE_ATTRIBUTE}]`);
    node && sources.length < 3;
    node = node.parentElement?.closest(`[${SOURCE_ATTRIBUTE}]`) ?? null
  ) {
    const source = node.getAttribute(SOURCE_ATTRIBUTE) ?? ''
    const file = source.replace(/:\d+:\d+$/, '')
    if (files.has(file)) continue
    files.add(file)
    sources.push(source)
  }
  return sources
}

export function capturePage(): PageRef {
  return { url: location.href, title: document.title, viewport: { width: innerWidth, height: innerHeight } }
}

/** Comments match a page by origin and path; query and hash are ignored. */
export function samePage(url: string): boolean {
  try {
    const other = new URL(url)
    return other.origin === location.origin && other.pathname === location.pathname
  } catch {
    return false
  }
}
