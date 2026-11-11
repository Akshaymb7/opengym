// Response and request helpers. Every API answer is JSON (frontend/src/lib/api.js treats a 2xx
// that is not JSON as someone else's answer), with no caching.

export const MAX_BODY = 5 * 1024 * 1024

export class HttpError extends Error {
  constructor(status, message, extra) { super(message); this.status = status; this.extra = extra || {} }
}

// `cookies` is a list of Set-Cookie values; each needs its own header line.
export function json(status, obj, { cookies = [], headers = {} } = {}) {
  const h = new Headers({ 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...headers })
  for (const c of cookies) h.append('Set-Cookie', c)
  return new Response(JSON.stringify(obj), { status, headers: h })
}

// A JSON body already serialised (GET /api/data sends the stored document without parsing it).
export function rawJson(status, body) {
  return new Response(body, { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } })
}

export async function readBody(request) {
  const declared = Number(request.headers.get('content-length'))
  if (Number.isFinite(declared) && declared > MAX_BODY) throw new HttpError(413, 'request too large')
  const raw = await request.text()
  if (raw.length > MAX_BODY) throw new HttpError(413, 'request too large')
  if (!raw.trim()) return {}
  let body
  try { body = JSON.parse(raw) } catch { throw new HttpError(400, 'invalid JSON') }
  if (!body || typeof body !== 'object') throw new HttpError(400, 'invalid JSON')
  return body
}

export const text = v => (typeof v === 'string' ? v : typeof v === 'number' ? String(v) : '')

export const b64u = bytes => {
  let s = ''
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i])
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}
export const fromB64u = s => Uint8Array.from(atob(String(s).replace(/-/g, '+').replace(/_/g, '/')), c => c.charCodeAt(0))
export const b64 = bytes => { let s = ''; for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]); return btoa(s) }
export const fromB64 = s => Uint8Array.from(atob(s), c => c.charCodeAt(0))

export const randomBytes = n => crypto.getRandomValues(new Uint8Array(n))
export const randomId = (n = 12) => b64u(randomBytes(n))
export const randomHex = n => Array.from(randomBytes(n), b => b.toString(16).padStart(2, '0')).join('')

// Same alphabet as api/server.js makePairCode: no 0/O/1/I, read off a screen.
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
export const readableCode = (len = 8) => Array.from(randomBytes(len), b => CODE_ALPHABET[b % CODE_ALPHABET.length]).join('')

// Constant-time string compare (both sides are our own fixed-length encodings).
export function sameString(a, b) {
  a = String(a); b = String(b)
  let diff = a.length ^ b.length
  for (let i = 0; i < Math.max(a.length, b.length); i++) diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0)
  return diff === 0
}
