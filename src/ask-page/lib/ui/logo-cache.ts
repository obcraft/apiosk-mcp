import { absoluteLogo } from '../../environment'

// Same detached-image probe as the App, shared per iframe. The host's fixed
// image allowlist remains authoritative; source records cannot extend it.
const probes = new Map<string, Promise<boolean>>()
export function probeLogo(value: string): Promise<boolean> {
  const url = absoluteLogo(value)!
  try {
    if (!(window as any).apioskAskPageLogoOrigins?.includes(new URL(url).origin)) return Promise.resolve(false)
  } catch { return Promise.resolve(false) }
  if (!probes.has(url)) probes.set(url, new Promise<boolean>(resolve => {
    const probe = new Image()
    const finish = (loaded: boolean) => { clearTimeout(timeout); probe.onload = null; probe.onerror = null; resolve(loaded) }
    const timeout = setTimeout(() => finish(false), 10_000)
    probe.onload = () => finish(probe.naturalWidth > 0)
    probe.onerror = () => finish(false)
    probe.decoding = 'async'
    probe.referrerPolicy = 'no-referrer'
    probe.src = url
  }))
  return probes.get(url)!
}
