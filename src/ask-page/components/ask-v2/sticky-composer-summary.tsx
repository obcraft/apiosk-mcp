import * as React from 'react'
import { useLayoutEffect, useRef, useState, type ComponentProps } from 'react'
import { createPortal } from 'react-dom'
import { useComposedRefs } from '@radix-ui/react-compose-refs'

/** Overlap between the summary's own place and the input that still counts as merely touching. */
const TOUCH_TOLERANCE_PX = 2

/** Merge into the input while the input covers the summary's own place; return when that place is clear again. */
export function StickyComposerSummary({ ref, ...props }: ComponentProps<'div'>) {
  const anchor = useRef<HTMLDivElement>(null)
  const bar = useRef<HTMLDivElement>(null)
  const refs = useComposedRefs(ref, bar)
  const previousRect = useRef<DOMRect | null>(null)
  const previousBackground = useRef<string | null>(null)
  const [dock, setDock] = useState<{ target: HTMLElement | null; height: number }>({ target: null, height: 0 })

  useLayoutEffect(() => {
    const marker = anchor.current, summary = bar.current
    const section = marker?.closest('.answer-content')
    if (!marker || !summary || !section) return
    const scroll = section.closest('#app-scroll')
    const input = section.querySelector<HTMLElement>('.ask-composer')
    let frame = 0
    const measure = () => {
      const slot = section.querySelector<HTMLElement>('[data-ask-summary-slot]')
      // One threshold, both directions: the summary joins the input once the
      // top of the input reaches the bottom of the summary's own place in its
      // card, and returns to that place at the same point. Measured from the
      // zero-height origin in normal flow, not from native sticky, which cannot
      // lift the summary beyond its small wrapper while the sources above it
      // scroll past. Its height stays reserved while portalled, so the
      // measured place does not move when it docks.
      const inputTop = input?.getBoundingClientRect().top ?? Infinity
      const stuck = [...section.querySelectorAll<HTMLElement>('[data-ask-summary-anchor]')].filter(candidate => {
        const origin = candidate.previousElementSibling
        if (!origin?.hasAttribute('data-ask-summary-origin') || candidate.closest('[data-docking]')) return false
        const height = candidate.getBoundingClientRect().height
        const placeBottom = origin.getBoundingClientRect().top + height
        return height > 0 && placeBottom - inputTop > TOUCH_TOLERANCE_PX
      })
      const target = stuck[stuck.length - 1] === marker ? slot : null
      if (target !== dock.target) {
        previousRect.current = summary.getBoundingClientRect()
        previousBackground.current = getComputedStyle(summary).backgroundColor
      }
      setDock(previous => {
        const height = target ? previous.target ? Math.max(previous.height, summary.getBoundingClientRect().height) : marker.getBoundingClientRect().height : 0
        return previous.target === target && previous.height === height ? previous : { target, height }
      })
    }
    const schedule = () => {
      cancelAnimationFrame(frame)
      frame = requestAnimationFrame(measure)
    }
    measure()
    const resize = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(schedule)
    for (const element of [marker, summary, section]) resize?.observe(element)
    if (input) resize?.observe(input)
    const changes = new MutationObserver(measure)
    changes.observe(section, { childList: true, subtree: true, attributes: true, attributeFilter: ['hidden', 'data-docking'] })
    scroll?.addEventListener('scroll', schedule, { passive: true })
    window.addEventListener('resize', schedule)
    window.visualViewport?.addEventListener('resize', schedule)
    return () => {
      cancelAnimationFrame(frame)
      resize?.disconnect()
      changes.disconnect()
      scroll?.removeEventListener('scroll', schedule)
      window.removeEventListener('resize', schedule)
      window.visualViewport?.removeEventListener('resize', schedule)
    }
  }, [dock.target])

  useLayoutEffect(() => {
    const from = previousRect.current, element = bar.current
    const backgroundColor = previousBackground.current
    previousRect.current = null
    previousBackground.current = null
    if (!from || !element?.animate || window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return
    const to = element.getBoundingClientRect()
    if (!from.width || !from.height || !to.width || !to.height) return
    const animation = element.animate([
      { backgroundColor: backgroundColor ?? getComputedStyle(element).backgroundColor, transformOrigin: 'top left', transform: `translate(${from.left - to.left}px, ${from.top - to.top}px) scale(${from.width / to.width}, ${from.height / to.height})` },
      { backgroundColor: getComputedStyle(element).backgroundColor, transformOrigin: 'top left', transform: 'none' },
    ], { duration: 240, easing: 'cubic-bezier(.22,1,.36,1)' })
    return () => animation.cancel()
  }, [dock.target])

  const summary = <div {...props} ref={refs} />
  return <>
    <div data-ask-summary-origin aria-hidden="true" />
    <div ref={anchor} data-ask-summary-anchor className="sticky bottom-[var(--ask-composer-height,0px)] z-[11]" style={dock.target ? { height: dock.height } : undefined}>
      {dock.target ? createPortal(summary, dock.target) : summary}
    </div>
  </>
}
