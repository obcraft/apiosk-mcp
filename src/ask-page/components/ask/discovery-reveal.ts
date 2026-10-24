import { useEffect, useMemo, useState } from 'react'

/** A one-way presentation step: later arrivals never hide an earlier step. */
export function useRevealDelay(ready: boolean, milliseconds: number, live: boolean) {
  const [elapsed, setElapsed] = useState(false)
  useEffect(() => {
    if (!live || !ready || elapsed) return
    const timer = window.setTimeout(() => setElapsed(true), milliseconds)
    return () => window.clearTimeout(timer)
  }, [ready, milliseconds, live, elapsed])
  return !live ? ready : elapsed
}

/** Type a fresh excerpt in small chunks; an appended excerpt keeps its prefix. */
export function useTypedText(text: string, enabled: boolean, live: boolean) {
  const letters = useMemo(() => [...new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(text)].map(part => part.segment), [text])
  const [progress, setProgress] = useState({ text, count: 0 })
  const count = progress.text === text ? progress.count : text.startsWith(progress.text) ? progress.count : 0
  if (progress.text !== text) setProgress({ text, count })
  const done = enabled && (!live || count >= letters.length)
  useEffect(() => {
    if (!live || !enabled || done) return
    // About two seconds at most, with a smaller step for a short title.
    const step = Math.max(1, Math.ceil(letters.length / 80))
    const timer = window.setInterval(() => setProgress(previous => previous.text === text ? { text, count: Math.min(letters.length, previous.count + step) } : previous), 24)
    return () => window.clearInterval(timer)
  }, [text, letters.length, live, enabled, done])
  return { shown: !enabled ? '' : done ? text : letters.slice(0, count).join(''), done }
}
