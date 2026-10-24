/** Media returned by a source, without fetching a URL or interpreting executable content. */
export type ResultMedia = {
  kind: 'image' | 'video' | 'audio' | 'file'
  url?: string
  bytes?: Uint8Array
  blob?: Blob
  mimeType: string
  name: string
  /** Original descriptor payload, used to avoid duplicating a selected result field. */
  source?: unknown
}

export type ResultMediaHints = { field?: string; mimeType?: string; name?: string }

const MAX_BYTES = 20 * 1024 * 1024
const MAX_ENCODED_LENGTH = Math.ceil(MAX_BYTES / 3) * 4
const MIME_BY_EXTENSION: Record<string, string> = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif',
  webp: 'image/webp', avif: 'image/avif', bmp: 'image/bmp', ico: 'image/x-icon',
  svg: 'image/svg+xml', tif: 'image/tiff', tiff: 'image/tiff', heic: 'image/heic', heif: 'image/heif',
  mp4: 'video/mp4', m4v: 'video/mp4', webm: 'video/webm', ogv: 'video/ogg', mov: 'video/quicktime',
  avi: 'video/x-msvideo', mkv: 'video/x-matroska',
  mp3: 'audio/mpeg', m4a: 'audio/mp4', wav: 'audio/wav', ogg: 'audio/ogg', opus: 'audio/ogg',
  aac: 'audio/aac', flac: 'audio/flac',
  pdf: 'application/pdf', zip: 'application/zip', gz: 'application/gzip',
  tar: 'application/x-tar', '7z': 'application/x-7z-compressed', rar: 'application/vnd.rar',
  csv: 'text/csv', tsv: 'text/tab-separated-values', txt: 'text/plain', json: 'application/json',
  xml: 'application/xml', html: 'text/html', htm: 'text/html',
  doc: 'application/msword', docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xls: 'application/vnd.ms-excel', xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  ppt: 'application/vnd.ms-powerpoint', pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  rtf: 'application/rtf', bin: 'application/octet-stream',
}
const INLINE_MIMES = {
  image: new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/avif', 'image/bmp', 'image/x-icon', 'image/vnd.microsoft.icon']),
  video: new Set(['video/mp4', 'video/webm', 'video/ogg', 'video/quicktime']),
  audio: new Set(['audio/mpeg', 'audio/mp4', 'audio/wav', 'audio/x-wav', 'audio/ogg', 'audio/aac', 'audio/flac', 'audio/webm']),
}
const URL_KEYS = ['url', 'uri', 'src', 'href', 'imageurl', 'videourl', 'audiourl', 'downloadurl', 'fileurl', 'sourceimg', 'image', 'images', 'img', 'photo', 'photos', 'picture', 'pictures', 'logo', 'icon', 'avatar', 'thumbnail', 'poster', 'video', 'videos', 'audio']
const BINARY_KEYS = ['base64', 'b64json', 'bytes', 'data', 'content', 'body']
const DESCRIPTOR_KEYS = new Set([
  ...URL_KEYS, ...BINARY_KEYS, 'mimetype', 'contenttype', 'mediatype',
  'encoding', 'type', 'name', 'filename', 'title', 'alt', 'caption', 'description',
  'size', 'length', 'width', 'height', 'duration', 'format', 'rel',
])

function normalizedMime(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const mime = value.split(';', 1)[0].trim().toLowerCase()
  return /^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/.test(mime) ? mime : undefined
}

function kindForMime(mime: string): ResultMedia['kind'] {
  if (INLINE_MIMES.image.has(mime)) return 'image'
  if (INLINE_MIMES.video.has(mime)) return 'video'
  if (INLINE_MIMES.audio.has(mime)) return 'audio'
  return 'file'
}

function normalizedField(field?: string): string {
  return field?.replace(/[^a-z0-9]/gi, '').toLowerCase() ?? ''
}

function mediaField(field?: string): 'image' | 'video' | 'audio' | undefined {
  const name = normalizedField(field)
  if (/^(?:sourceimg|images?|imgs?|photos?|pictures?|thumbnails?|posters?|logos?|icons?|avatars?)(?:url|uri|src|data|base64|bytes)?$/.test(name)) return 'image'
  if (/^(?:videos?|movies?)(?:url|uri|src|data|base64|bytes)?$/.test(name)) return 'video'
  if (/^(?:audio|sounds?|voice)(?:url|uri|src|data|base64|bytes)?$/.test(name)) return 'audio'
  return undefined
}

/** Share descriptor metadata only with payloads, never unrelated business values. */
export function resultMediaHints(record: Record<string, unknown>, field: string): ResultMediaHints {
  const hints: ResultMediaHints = { field }
  const payload = /^(?:url|uri|href|src|downloadurl|fileurl|asset|attachment|file|media|data|content|body|value|bytes|base64|b64json)$/.test(normalizedField(field)) || !!mediaField(field)
  if (!payload) return hints
  const entries = Object.entries(record).map(([key, value]) => [normalizedField(key), value] as const)
  for (const key of ['mimetype', 'contenttype', 'mediatype', 'type']) {
    const mime = entries.find(([name, value]) => name === key && !!normalizedMime(value))?.[1]
    if (typeof mime === 'string') { hints.mimeType = mime; break }
  }
  for (const key of ['filename', 'name', 'title', 'alt', 'caption']) {
    const name = entries.find(([fieldName, value]) => fieldName === key && typeof value === 'string' && !!value.trim())?.[1]
    if (typeof name === 'string') { hints.name = name; break }
  }
  return hints
}

function safeName(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const name = Array.from(value.trim()).filter(char => char.charCodeAt(0) > 31 && char.charCodeAt(0) !== 127).join('').split(/[\\/]/).pop()
  return name ? name.slice(0, 200) : undefined
}

function extensionMime(name?: string): string | undefined {
  return MIME_BY_EXTENSION[name?.match(/\.([a-z0-9]+)$/i)?.[1].toLowerCase() ?? '']
}

function defaultName(mime: string, kind: ResultMedia['kind']): string {
  const ext = Object.keys(MIME_BY_EXTENSION).find(key => MIME_BY_EXTENSION[key] === mime)
  return `${kind === 'file' ? 'file' : kind}${ext ? `.${ext}` : ''}`
}

// Literal local addresses must never cause an automatic browser media request.
function publicHost(host: string): boolean {
  const hostname = host.toLowerCase().replace(/\.$/, '').replace(/^\[|\]$/g, '')
  if (!hostname || hostname === 'localhost.localdomain' || hostname === 'localhost' || /(?:^|\.)(?:localhost|local|internal|lan|home|test|invalid)$/.test(hostname)) return false
  if (hostname.includes(':')) {
    return !/^(?:::|::1$|0*:0*:0*:0*:0*:0*:|f[cd]|fe[89ab]|ff)/.test(hostname)
  }
  const parts = hostname.split('.')
  if (parts.length === 4 && parts.every(part => /^\d+$/.test(part))) {
    const [a, b] = parts.map(Number)
    return !(a === 0 || a === 10 || a === 127 || a >= 224 || (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) ||
      (a === 198 && (b === 18 || b === 19)))
  }
  return hostname.includes('.')
}

function fromUrl(value: string, hints: ResultMediaHints): ResultMedia | null {
  // URL() normalizes spaces, controls and backslashes; a media source must be an exact URL.
  if (/[\s\\]/u.test(value) || Array.from(value).some(char => char.charCodeAt(0) <= 31 || char.charCodeAt(0) === 127)) return null
  let parsed: URL
  try { parsed = new URL(value) } catch { return null }
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) return null
  let filename: string | undefined
  try { filename = safeName(decodeURIComponent(parsed.pathname.split('/').pop() ?? '')) } catch { filename = safeName(parsed.pathname.split('/').pop()) }
  const fieldKind = mediaField(hints.field)
  const urlMime = extensionMime(filename)
  const downloadField = /^(?:download|file)(?:url|uri)?$/.test(normalizedField(hints.field))
  const mimeType = normalizedMime(hints.mimeType) ?? (urlMime === 'text/html' ? undefined : urlMime) ?? (fieldKind ? `${fieldKind}/*` : downloadField ? 'application/octet-stream' : undefined)
  if (!mimeType) return null
  const activeFile = urlMime === 'image/svg+xml' || urlMime === 'text/html'
  const kind = publicHost(parsed.hostname) && !activeFile ? (fieldKind && mimeType === `${fieldKind}/*` ? fieldKind : kindForMime(mimeType)) : 'file'
  return { kind, url: value, mimeType, name: safeName(hints.name) ?? filename ?? defaultName(mimeType, kind) }
}

function sniffMime(bytes: Uint8Array): string | undefined {
  const starts = (...values: number[]) => values.every((value, index) => bytes[index] === value)
  const ascii = (start: number, length: number) => String.fromCharCode(...bytes.subarray(start, start + length))
  if (starts(137, 80, 78, 71, 13, 10, 26, 10)) return 'image/png'
  if (starts(255, 216, 255) && bytes.length >= 4) return 'image/jpeg'
  if (['GIF87a', 'GIF89a'].includes(ascii(0, 6))) return 'image/gif'
  if (ascii(0, 4) === 'RIFF' && ascii(8, 4) === 'WEBP') return 'image/webp'
  if (ascii(0, 4) === 'RIFF' && ascii(8, 4) === 'WAVE') return 'audio/wav'
  if (bytes.length >= 12 && ascii(4, 4) === 'ftyp') {
    const brand = ascii(8, 4)
    if (['avif', 'avis'].includes(brand)) return 'image/avif'
    if (['heic', 'heix', 'hevc', 'hevx', 'mif1', 'msf1'].includes(brand)) return 'image/heic'
    if (brand === 'qt  ') return 'video/quicktime'
    if (['M4A ', 'M4B '].includes(brand)) return 'audio/mp4'
    return 'video/mp4'
  }
  if (starts(26, 69, 223, 163) && ascii(4, 60).includes('webm')) return 'video/webm'
  if (ascii(0, 5) === '%PDF-') return 'application/pdf'
  if (starts(80, 75, 3, 4) || starts(80, 75, 5, 6) || starts(80, 75, 7, 8)) return 'application/zip'
  if (ascii(0, 3) === 'ID3' && bytes.length >= 10) return 'audio/mpeg'
  if (ascii(0, 4) === 'fLaC') return 'audio/flac'
  if (ascii(0, 4) === 'OggS' && bytes.length >= 8) return 'audio/ogg'
  return undefined
}

function fromBytes(bytes: Uint8Array, hints: ResultMediaHints): ResultMedia | null {
  if (!bytes.byteLength) return null
  const mimeType = normalizedMime(hints.mimeType) ?? sniffMime(bytes) ?? extensionMime(hints.name) ?? 'application/octet-stream'
  // Existing binary values remain downloadable even when too large for an inline preview.
  // Encoded strings are bounded before decoding, so this does not relax their allocation cap.
  const kind = bytes.byteLength > MAX_BYTES ? 'file' : kindForMime(mimeType)
  return { kind, bytes, mimeType, name: safeName(hints.name) ?? defaultName(mimeType, kind) }
}

function decodeBase64(value: string): Uint8Array | null {
  if (value.length > MAX_ENCODED_LENGTH + 1024) return null
  const text = value.replace(/[\t\r\n ]/g, '')
  if (!text || text.length > MAX_ENCODED_LENGTH || text.length % 4 === 1 || !/^[A-Za-z0-9+/]*={0,2}$/.test(text)) return null
  if (text.includes('=') && text.length % 4 !== 0) return null
  try {
    const decoded = atob(text)
    // Reject noncanonical trailing bits as well as truncated/invalid encodings.
    if (btoa(decoded).replace(/=+$/, '') !== text.replace(/=+$/, '') || decoded.length > MAX_BYTES) return null
    return Uint8Array.from(decoded, char => char.charCodeAt(0))
  } catch { return null }
}

function fromDataUri(value: string, hints: ResultMediaHints): ResultMedia | null {
  if (value.length > MAX_ENCODED_LENGTH + 1024) return null
  const match = /^data:([^,]*),([\s\S]*)$/i.exec(value)
  if (!match) return null
  const headers = match[1].split(';')
  if (headers[0] && !normalizedMime(headers[0])) return null
  const mimeType = normalizedMime(headers[0]) ?? 'text/plain'
  let bytes: Uint8Array | null
  if (headers.some(header => header.toLowerCase() === 'base64')) {
    bytes = decodeBase64(match[2])
  } else {
    try {
      const payload = match[2]
      const output = new Uint8Array(Math.min(MAX_BYTES, payload.length * 3))
      let offset = 0
      for (let index = 0; index < payload.length; index += 1) {
        if (payload[index] === '%') {
          const hex = payload.slice(index + 1, index + 3)
          if (!/^[0-9a-fA-F]{2}$/.test(hex) || offset >= MAX_BYTES) return null
          output[offset++] = parseInt(hex, 16)
          index += 2
        } else {
          const code = payload.codePointAt(index)!
          const chunk = code < 128 ? [code] : new TextEncoder().encode(String.fromCodePoint(code))
          if (offset + chunk.length > MAX_BYTES) return null
          output.set(chunk, offset)
          offset += chunk.length
          if (code > 0xffff) index += 1
        }
      }
      bytes = output.subarray(0, offset)
    } catch { return null }
  }
  return bytes ? fromBytes(bytes, { ...hints, mimeType }) : null
}

function textMedia(value: string, hints: ResultMediaHints, encoded = false): ResultMedia | null {
  const text = value.trim()
  if (!text) return null
  if (/^data:/i.test(text)) return fromDataUri(text, hints)
  if (/^https?:\/\//i.test(text)) return fromUrl(value, hints)
  const bytes = decodeBase64(text)
  if (!bytes || (!encoded && !/^(?:base64|b64json)$/.test(normalizedField(hints.field)) && !normalizedMime(hints.mimeType) && !mediaField(hints.field) && !sniffMime(bytes))) return null
  return fromBytes(bytes, hints)
}

/** Detect a single media value. Mixed business records deliberately remain ordinary records. */
export function resultMedia(value: unknown, hints: ResultMediaHints = {}): ResultMedia | null {
  if (typeof value === 'string') return textMedia(value, hints)
  if (value instanceof Uint8Array) return fromBytes(value, hints)
  if (value instanceof ArrayBuffer) return fromBytes(new Uint8Array(value), hints)
  if (ArrayBuffer.isView(value)) return fromBytes(new Uint8Array(value.buffer, value.byteOffset, value.byteLength), hints)
  if (typeof Blob !== 'undefined' && value instanceof Blob) {
    if (!value.size) return null
    const name = safeName(hints.name) ?? (typeof File !== 'undefined' && value instanceof File ? safeName(value.name) : undefined)
    const mimeType = normalizedMime(hints.mimeType) ?? normalizedMime(value.type) ?? extensionMime(name) ?? 'application/octet-stream'
    const kind = kindForMime(mimeType)
    return { kind, blob: value, mimeType, name: name ?? defaultName(mimeType, kind) }
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const entries = Object.entries(value as Record<string, unknown>)
  if (!entries.length || entries.some(([key]) => !DESCRIPTOR_KEYS.has(normalizedField(key)) && !mediaField(key))) return null
  const record = Object.fromEntries(entries.map(([key, entry]) => [normalizedField(key), entry]))
  const payloadKeys = Object.keys(record).filter(key => (URL_KEYS.includes(key) || BINARY_KEYS.includes(key) || mediaField(key)) && record[key] != null && record[key] !== '')
  if (payloadKeys.length > 1) return null
  const firstString = (keys: string[]) => keys.map(key => record[key]).find(item => typeof item === 'string') as string | undefined
  const mimeType = resultMediaHints(record, payloadKeys[0] ?? 'data').mimeType ?? hints.mimeType
  const name = firstString(['filename', 'name', 'title', 'alt', 'caption']) ?? hints.name
  for (const key of new Set([...URL_KEYS, ...Object.keys(record).filter(key => mediaField(key))])) {
    const entry = record[key]
    if (typeof entry === 'string') {
      const media = textMedia(entry, { field: ['url', 'uri', 'src', 'href'].includes(key) ? hints.field : key, mimeType, name })
      if (media) return { ...media, source: entry }
    } else if (entry && typeof entry === 'object' && !Array.isArray(entry) && Object.keys(entry).every(child => ['url', 'detail'].includes(child))) {
      const url = (entry as Record<string, unknown>).url
      if (typeof url === 'string') {
        const media = textMedia(url, { field: key, mimeType, name })
        if (media) return { ...media, source: url }
      }
    }
  }
  for (const key of BINARY_KEYS) {
    const entry = record[key]
    const nextHints = { field: hints.field, mimeType, name }
    const explicitEncoding = ['base64', 'b64json'].includes(key) || record.encoding === 'base64'
    if (typeof entry === 'string') {
      const media = textMedia(entry, nextHints, explicitEncoding)
      if (media) return { ...media, source: entry }
    } else if (ArrayBuffer.isView(entry) || entry instanceof ArrayBuffer || (typeof Blob !== 'undefined' && entry instanceof Blob)) {
      const media = resultMedia(entry, nextHints)
      if (media) return { ...media, source: entry }
    } else if (Array.isArray(entry) && (key === 'bytes' || record.type === 'Buffer' || !!normalizedMime(mimeType)) &&
      entry.length <= MAX_BYTES && entry.every(byte => Number.isInteger(byte) && byte >= 0 && byte <= 255)) {
      const media = fromBytes(Uint8Array.from(entry), nextHints)
      return media ? { ...media, source: entry } : null
    }
  }
  return null
}
