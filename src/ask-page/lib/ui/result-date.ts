const dateFormat = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' })

/** Format the source's calendar date and clock time without assuming a timezone. */
export function resultDate(value: unknown): { date: string; time?: string; raw?: string } {
  if (typeof value !== 'string' || !value.trim()) return { date: 'Not provided' }
  const raw = value.trim()
  const match = /^(\d{4}-\d{2}-\d{2})(?:T(\d{2}):(\d{2})(?::(\d{2})(\.\d+)?)?(Z|[+-]\d{2}:\d{2})?)?$/.exec(raw)
  if (!match) return { date: raw }
  const at = new Date(`${match[1]}T00:00:00Z`)
  const [, , hour, minute, second, fraction, zone] = match
  if (!Number.isFinite(at.getTime()) || at.toISOString().slice(0, 10) !== match[1]
    || hour && (Number(hour) > 23 || Number(minute) > 59 || Number(second ?? 0) > 59)
    || zone && zone !== 'Z' && (Number(zone.slice(1, 3)) > 23 || Number(zone.slice(4)) > 59)) return { date: raw }
  const seconds = second && (second !== '00' || fraction) ? `:${second}${fraction ?? ''}` : ''
  return {
    date: dateFormat.format(at), raw,
    time: hour ? `${hour}:${minute}${seconds}${zone ? zone === 'Z' ? ' UTC' : ` UTC${zone}` : ''}` : undefined,
  }
}
