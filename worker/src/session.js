// Sessions: the same signed token as api/server.js — `<uid>:<expiry>:<version>:<kind>.<hmac>` —
// in a cookie for the browser and as a Bearer for the paired phone app. Bumping a user's `sv`
// ("sign out everywhere", a new password) ends every token issued before.
import { b64u, sameString } from './http.js'

const enc = new TextEncoder()
const keys = new Map()
async function hmacKey(secret) {
  let k = keys.get(secret)
  if (!k) {
    k = crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
    keys.set(secret, k)
  }
  return k
}
async function mac(secret, payload) {
  return b64u(new Uint8Array(await crypto.subtle.sign('HMAC', await hmacKey(secret), enc.encode(payload))))
}
export async function sign(secret, payload) { return payload + '.' + await mac(secret, payload) }
export async function verifySig(secret, token) {
  const i = String(token).lastIndexOf('.')
  if (i < 0) return null
  const payload = token.slice(0, i)
  return sameString(token.slice(i + 1), await mac(secret, payload)) ? payload : null
}

export const sessionVersion = u => u.sv || 0

// kind: 'c' a browser cookie, 'b' a paired phone's bearer (only those are renewed by GET /api/me).
export function makeSession(cfg, user, kind = 'b') {
  const exp = Date.now() + cfg.SESSION_DAYS * 86400000
  return sign(cfg.SECRET, `${user.id}:${exp}:${sessionVersion(user)}:${kind}`)
}

const LEGACY = 'gymsid'
const cookieName = cfg => (cfg.SECURE ? '__Host-gymsid' : LEGACY)
function cookieValues(request, name) {
  const out = []
  for (const c of (request.headers.get('cookie') || '').split(';')) {
    const i = c.indexOf('=')
    if (i >= 0 && c.slice(0, i).trim() === name) out.push(c.slice(i + 1).trim())
  }
  return out
}
// Two different values under one name means someone planted one: refuse both.
export function cookieToken(cfg, request) {
  const name = cookieName(cfg)
  for (const n of name === LEGACY ? [name] : [name, LEGACY]) {
    const vals = cookieValues(request, n)
    if (!vals.length) continue
    if (vals.some(v => v !== vals[0])) return null
    return vals[0]
  }
  return null
}

// { user, exp, kind } for a valid token, else null.
export async function sessionUser(cfg, repo, tok) {
  if (!tok || !cfg.SECRET) return null
  const payload = await verifySig(cfg.SECRET, tok)
  if (!payload) return null
  const [uid, exp, ver, kind] = payload.split(':')
  if (!uid || +exp < Date.now()) return null
  const user = await repo.user(uid)
  if (!user || user.disabled) return null
  const claimed = ver === undefined ? 0 : Number(ver)
  if (!Number.isInteger(claimed) || claimed !== sessionVersion(user)) return null
  return { user, exp: +exp, kind: kind || null }
}

// The session behind a request — the cookie first, else a Bearer — memoised per request.
export async function sessionOf(ctx) {
  if (ctx._session !== undefined) return ctx._session
  const { cfg, repo, request } = ctx
  const auth = request.headers.get('authorization') || ''
  const cookie = cookieToken(cfg, request)
  const tok = cookie || (auth.startsWith('Bearer ') ? auth.slice(7).trim() : null)
  const s = await sessionUser(cfg, repo, tok)
  ctx._session = s && { ...s, bearer: !cookie }
  return ctx._session
}
export async function readSession(ctx) { return (await sessionOf(ctx))?.user || null }

const flags = cfg => `Path=/; HttpOnly;${cfg.SECURE ? ' Secure;' : ''} SameSite=Lax`
const expire = (cfg, name) => `${name}=; Max-Age=0; ${flags(cfg)}`
export async function sessionCookie(cfg, user) {
  const name = cookieName(cfg)
  const fresh = `${name}=${await makeSession(cfg, user, 'c')}; Max-Age=${cfg.SESSION_DAYS * 86400}; ${flags(cfg)}`
  return name === LEGACY ? [fresh] : [fresh, expire(cfg, LEGACY)]
}
export const clearCookie = cfg => {
  const name = cookieName(cfg)
  return name === LEGACY ? [expire(cfg, LEGACY)] : [expire(cfg, name), expire(cfg, LEGACY)]
}
