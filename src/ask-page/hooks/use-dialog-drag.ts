import { useEffect, useLayoutEffect, useRef, type RefObject } from 'react'

/** Drag only the sheet chrome: scrolling, selecting and controls in the answer stay native. */
export function useDialogDrag(panel: RefObject<HTMLDivElement | null>, enabled: boolean, onClose: () => void, mediaQuery = '(max-width: 639px)', open = enabled) {
  const close = useRef(onClose)
  const releaseGesture = useRef<(() => void) | null>(null)
  useEffect(() => { close.current = onClose })

  // Reopening during the exit keeps the same DOM node. Its previous dragged
  // offset must not carry into the new opening, while closing keeps it intact.
  useLayoutEffect(() => {
    const node = panel.current
    if (!enabled || !open || !node) return
    releaseGesture.current?.()
    node.removeAttribute('data-sheet-drag')
    node.style.removeProperty('--sheet-offset')
    node.parentElement?.style.removeProperty('--sheet-dim')
  }, [panel, enabled, open])

  useEffect(() => {
    const node = panel.current
    if (!enabled || !node || !window.matchMedia) return
    const mobile = window.matchMedia(mediaQuery)
    const overlay = node.parentElement
    let gesture: { id: number; x: number; y: number; lastY: number; time: number; speed: number; distance: number } | null = null

    const release = () => {
      const id = gesture?.id
      gesture = null
      if (id !== undefined && node.hasPointerCapture?.(id)) node.releasePointerCapture(id)
    }
    const reset = () => {
      release()
      node.dataset.sheetDrag = 'settling'
      node.style.setProperty('--sheet-offset', '0px')
      overlay?.style.removeProperty('--sheet-dim')
    }
    const down = (event: PointerEvent) => {
      const target = event.target
      if (!mobile.matches || gesture || event.isPrimary === false || event.button !== 0
        || node.dataset.dialogClosing === 'true' || !(target instanceof Element)
        || !target.closest('[data-dialog-drag-handle], [data-dialog-header]')
        || target.closest('button, a, input, textarea, select, [role="button"], [contenteditable]')) return
      gesture = { id: event.pointerId, x: event.clientX, y: event.clientY, lastY: event.clientY, time: event.timeStamp, speed: 0, distance: 0 }
      node.setPointerCapture?.(event.pointerId)
      event.preventDefault()
    }
    const move = (event: PointerEvent) => {
      if (!gesture || gesture.id !== event.pointerId || node.dataset.dialogClosing === 'true') return
      const dy = event.clientY - gesture.y
      const dx = Math.abs(event.clientX - gesture.x)
      if (dx > 8 && dx > Math.abs(dy)) { reset(); return }
      if (Math.abs(dy) < 6 && !gesture.distance) return
      const elapsed = event.timeStamp - gesture.time
      if (elapsed > 0) gesture.speed = (event.clientY - gesture.lastY) / elapsed
      gesture.lastY = event.clientY
      gesture.time = event.timeStamp
      gesture.distance = dy
      node.dataset.sheetDrag = 'active'
      // A little resistance at the top; downward movement tracks the finger.
      node.style.setProperty('--sheet-offset', `${dy < 0 ? -Math.min(18, Math.sqrt(-dy) * 2) : dy}px`)
      const height = node.getBoundingClientRect().height || window.innerHeight
      overlay?.style.setProperty('--sheet-dim', String(1 - Math.min(0.9, Math.max(0, dy) / height)))
      event.preventDefault()
    }
    const up = (event: PointerEvent) => {
      if (!gesture || gesture.id !== event.pointerId) return
      if (node.dataset.dialogClosing === 'true') { release(); return }
      const distance = gesture.distance
      const speed = event.timeStamp - gesture.time < 100 ? gesture.speed : 0
      const threshold = Math.min(160, Math.max(96, node.getBoundingClientRect().height * 0.22))
      release()
      node.dataset.sheetDrag = 'settling'
      if (distance >= threshold || (distance > 32 && speed > 0.6)) close.current()
      else { node.style.setProperty('--sheet-offset', '0px'); overlay?.style.removeProperty('--sheet-dim') }
    }
    const cancel = (event: PointerEvent) => { if (gesture?.id === event.pointerId) reset() }
    const resize = () => { if (!mobile.matches) reset() }
    releaseGesture.current = release
    node.addEventListener('pointerdown', down)
    node.addEventListener('pointermove', move)
    node.addEventListener('pointerup', up)
    node.addEventListener('pointercancel', cancel)
    node.addEventListener('lostpointercapture', cancel)
    mobile.addEventListener('change', resize)
    return () => {
      node.removeEventListener('pointerdown', down)
      node.removeEventListener('pointermove', move)
      node.removeEventListener('pointerup', up)
      node.removeEventListener('pointercancel', cancel)
      node.removeEventListener('lostpointercapture', cancel)
      mobile.removeEventListener('change', resize)
      release()
      if (releaseGesture.current === release) releaseGesture.current = null
      delete node.dataset.sheetDrag
      node.style.removeProperty('--sheet-offset')
      overlay?.style.removeProperty('--sheet-dim')
    }
  }, [panel, enabled, mediaQuery])
}
