// openGym API on Cloudflare Workers + D1. The app itself (../frontend/dist) is served as static
// assets; only /api/* reaches this code (wrangler.jsonc run_worker_first).
//
// Same contract as api/server.js for the routes the app needs to sign in and sync. Optional
// features of the Node server (Coach, push, media uploads, watch relay, integrations, audit log)
// are absent: /api/config does not advertise them, so the app hides them.
import { configOf } from './config.js'
import { json, HttpError } from './http.js'
import { makeRepo } from './repo.js'
import { cookieToken, sessionUser } from './session.js'
import { signinRoutes, passwordSigninRoutes } from './routes-signin.js'
import { accountRoutes, passwordAccountRoutes } from './routes-account.js'
import { dataRoutes } from './routes-data.js'
import { mealRoutes } from './routes-meals.js'

export function routesFor(cfg) {
  return {
    ...signinRoutes,
    ...accountRoutes,
    ...dataRoutes,
    // Absent while PASSWORD_LOGIN is off, so each is a plain 404 (as in api/server.js).
    ...(cfg.PASSWORD_LOGIN ? { ...passwordSigninRoutes, ...passwordAccountRoutes } : {}),
    // Absent without an AI binding: the app hides Meals then (/api/config `meals`).
    ...(cfg.MEALS ? mealRoutes : {})
  }
}

/* ---------- CSRF (api/server.js csrfOk) ----------
   A state-changing request from a browser must come from ORIGIN. pair/redeem is exempt: the phone
   calls it from its own WebView origin, and the code in the body is the credential. A Bearer that
   verifies on its own (a paired phone, no cookie beside it) carries no ambient authority. */
const CSRF_EXEMPT = new Set(['POST /api/pair/redeem'])
const BODY_CREDENTIAL = new Set([
  'POST /api/register/options', 'POST /api/register/verify', 'POST /api/login/options', 'POST /api/login/verify',
  'POST /api/login/password', 'POST /api/register/password'
])
async function bearerAuthenticates(ctx) {
  const auth = ctx.request.headers.get('authorization') || ''
  if (!auth.startsWith('Bearer ') || cookieToken(ctx.cfg, ctx.request)) return false
  return !!(await sessionUser(ctx.cfg, ctx.repo, auth.slice(7).trim()))
}
async function csrfOk(ctx, key) {
  const m = ctx.request.method
  if (m === 'GET' || m === 'HEAD' || m === 'OPTIONS') return true
  if (CSRF_EXEMPT.has(key)) return true
  if (!BODY_CREDENTIAL.has(key) && await bearerAuthenticates(ctx)) return true
  const site = ctx.request.headers.get('sec-fetch-site')
  if (site) return site === 'same-origin' || site === 'none'
  const origin = ctx.request.headers.get('origin')
  if (!origin) return true // not a browser
  return origin.replace(/\/+$/, '') === ctx.cfg.ORIGIN
}

/* ---------- CORS: only the paired phone app is cross-origin ----------
   It carries no cookie (a Bearer instead), so the origin is reflected and credentials are never
   allowed: nothing of the cookie session is exposed. */
function withCors(res, origin) {
  if (!origin) return res
  const out = new Response(res.body, res)
  out.headers.set('Access-Control-Allow-Origin', origin)
  out.headers.append('Vary', 'Origin')
  return out
}
function preflight(origin) {
  return new Response(null, {
    status: 204,
    headers: {
      ...(origin ? { 'Access-Control-Allow-Origin': origin, Vary: 'Origin' } : {}),
      'Access-Control-Allow-Methods': 'GET,POST,PUT,DELETE,OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization, CF-Access-Client-Id, CF-Access-Client-Secret',
      'Access-Control-Max-Age': '86400'
    }
  })
}

export async function handleApi(request, env) {
  const cfg = configOf(env)
  const origin = request.headers.get('origin')
  if (request.method === 'OPTIONS') return preflight(origin)
  const url = new URL(request.url)
  const key = request.method + ' ' + url.pathname
  const handler = routesFor(cfg)[key]
  if (!handler) return withCors(json(404, { error: 'not found' }), origin)
  if (!cfg.SECRET || cfg.SECRET.length < 32) {
    return withCors(json(500, { error: 'server not configured: set the SESSION_SECRET secret (32+ characters)' }), origin)
  }
  const db = env.DB
  const ctx = { request, env, cfg, url, key, db, repo: makeRepo(db) }
  try {
    if (!(await csrfOk(ctx, key))) {
      const auth = request.headers.get('authorization') || ''
      if (auth.startsWith('Bearer ') && !cookieToken(cfg, request) && !(await bearerAuthenticates(ctx))) {
        return withCors(json(401, { error: 'not signed in' }), origin)
      }
      return withCors(json(403, { error: 'cross-origin request refused', code: 'origin-mismatch', expected: cfg.ORIGIN }), origin)
    }
    return withCors(await handler(ctx), origin)
  } catch (e) {
    if (e instanceof HttpError) return withCors(json(e.status, { error: e.message, ...e.extra }), origin)
    console.error(key, e && e.stack || e)
    return withCors(json(500, { error: 'server error' }), origin)
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url)
    if (url.pathname.startsWith('/api/')) return handleApi(request, env)
    return env.ASSETS.fetch(request)
  }
}
