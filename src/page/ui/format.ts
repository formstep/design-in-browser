const time = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' })
const dayAndTime = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })

/** "14:05" today, "Nov 18, 14:05" before. */
export function when(iso: string): string {
  const date = new Date(iso)
  return (date.toDateString() === new Date().toDateString() ? time : dayAndTime).format(date)
}

export const plural = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`
