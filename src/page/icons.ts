// One icon set for the panel and the overlay: 24-unit grid, 2px round strokes, drawn in currentColor.
const paths = {
  close: '<path d="M18 6 6 18M6 6l12 12"/>',
  check: '<path d="M20 6 9 17l-5-5"/>',
  question: '<path d="M9.1 9a3 3 0 0 1 5.8 1c0 2-3 3-3 3"/><path d="M12 17h.01"/>',
  minus: '<path d="M5 12h14"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  copy: '<rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>',
  alert: '<circle cx="12" cy="12" r="9"/><path d="M12 8v4M12 16h.01"/>',
  comment: '<path d="M4 20V12a8 8 0 1 1 8 8z"/>',
  arrowUp: '<path d="M12 19V5M5.5 11.5 12 5l6.5 6.5"/>',
  chevronDown: '<path d="m7 10 5 5 5-5"/>',
  trash: '<path d="M4 7h16M9 7V4.5h6V7M6.5 7l1 13h9l1-13"/>',
  layers: '<path d="m12 3 9 5-9 5-9-5z"/><path d="m3 13 9 5 9-5"/>',
  chevronLeft: '<path d="m15 6-6 6 6 6"/>',
  chevronRight: '<path d="m9 6 6 6-6 6"/>',
  sliders: '<path d="M4 7h10M18 7h2M4 17h4M12 17h8"/><circle cx="16" cy="7" r="2"/><circle cx="10" cy="17" r="2"/>',
  square: '<rect x="4" y="5" width="16" height="14" rx="1.5"/>',
  arrowUpRight: '<path d="M7 17 17 7M9 7h8v8"/>',
  pen: '<path d="M4 20c3-1 4-4 7-7l6-6a2 2 0 0 1 3 3l-6 6c-3 3-6 4-7 7"/>',
} as const

export type IconName = keyof typeof paths

export function icon(name: IconName, size = 16): string {
  return `<svg class="icon" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${paths[name]}</svg>`
}

/** Fills every `[data-icon]` placeholder under `root`. */
export function fillIcons(root: ParentNode): void {
  for (const node of root.querySelectorAll<HTMLElement>('[data-icon]')) {
    node.innerHTML = icon(node.dataset.icon as IconName, Number(node.dataset.size ?? 16))
  }
}
