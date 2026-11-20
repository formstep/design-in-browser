// Whether the user hid the comment markers (pins, and the drawings of comments not sent yet) to look at the page as
// it is. Toggled from the dock's header and kept in this browser, so it holds across reloads; markers come back as
// soon as the user starts commenting again.

const KEY = 'design-in-browser:markers-hidden'
const listeners = new Set<() => void>()

/** Storage can be blocked (a private window, site data off): the page then starts with markers shown. */
function stored(): boolean {
  try {
    return localStorage.getItem(KEY) === '1'
  } catch {
    return false
  }
}

let hidden = stored()

export const markersHidden = () => hidden

export function setMarkersHidden(next: boolean): void {
  if (next === hidden) return
  hidden = next
  try {
    localStorage.setItem(KEY, next ? '1' : '0')
  } catch {
    // Not kept past this page: the toggle still works here.
  }
  for (const listener of listeners) listener()
}

export function onMarkersHiddenChange(listener: () => void): void {
  listeners.add(listener)
}
