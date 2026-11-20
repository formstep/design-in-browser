const time = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' })
const dayAndTime = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })

/** "14:05" today, "Nov 18, 14:05" before. */
export function when(iso: string): string {
  const date = new Date(iso)
  return (date.toDateString() === new Date().toDateString() ? time : dayAndTime).format(date)
}

export const plural = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`

/**
 * How an element is named to the user: its tag and its text (`button “Start free”`), or, with no text, its tag with
 * its id or first class (`img.logo`). Class lists and paths are for the agent, which gets them in full.
 */
export function elementName(element: { tag: string; id: string | null; classes: string[]; text: string }): string {
  if (element.text) return `${element.tag} “${element.text}”`
  if (element.id) return `${element.tag}#${element.id}`
  const [first] = element.classes
  return first ? `${element.tag}.${first}` : element.tag
}
