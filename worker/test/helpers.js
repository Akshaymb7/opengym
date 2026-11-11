// A D1 stand-in over node:sqlite (same SQL engine as D1), and a client for handleApi().
import { DatabaseSync } from 'node:sqlite'
import { readFileSync } from 'node:fs'
import { handleApi } from '../src/index.js'

const SCHEMA = readFileSync(new URL('../migrations/0001_init.sql', import.meta.url), 'utf8')

export function fakeD1() {
  const db = new DatabaseSync(':memory:')
  db.exec(SCHEMA)
  const norm = args => args.map(v => {
    if (v === undefined) throw new Error('D1_TYPE_ERROR: Type undefined is not supported')
    return typeof v === 'boolean' ? (v ? 1 : 0) : v
  })
  const plain = r => (r ? { ...r } : null)
  class Stmt {
    constructor(sql, args = []) { this.sql = sql; this.args = args }
    bind(...a) { return new Stmt(this.sql, a) }
    async first() { return plain(db.prepare(this.sql).get(...norm(this.args))) }
    async all() { return { results: db.prepare(this.sql).all(...norm(this.args)).map(plain), success: true, meta: {} } }
    async run() { const r = db.prepare(this.sql).run(...norm(this.args)); return { success: true, meta: { changes: Number(r.changes) } } }
    exec() {
      const st = db.prepare(this.sql)
      return /^\s*(SELECT|WITH)|RETURNING/i.test(this.sql) ? st.all(...norm(this.args)).map(plain) : (st.run(...norm(this.args)), [])
    }
  }
  return {
    sqlite: db,
    prepare: sql => new Stmt(sql),
    // D1 runs a batch as one transaction: all or nothing.
    async batch(stmts) {
      db.exec('BEGIN')
      try { const out = stmts.map(s => ({ results: s.exec(), success: true })); db.exec('COMMIT'); return out }
      catch (e) { db.exec('ROLLBACK'); throw e }
    }
  }
}

export const ORIGIN = 'https://gym.test'

export function makeEnv(over = {}) {
  return {
    DB: fakeD1(), ORIGIN, RP_ID: 'gym.test', RP_NAME: 'openGym test',
    INVITE_ONLY: '1', PASSWORD_LOGIN: '1', ALLOW_GUEST: '1', SESSION_DAYS: '90',
    SESSION_SECRET: 's'.repeat(48), SETUP_CODE: 'SETUP-CODE-1', PBKDF2_ITER: '10000',
    ...over
  }
}

// One request. `as` is a signed-in client ({ cookie } or { bearer }); `site` is Sec-Fetch-Site.
export async function call(env, method, path, { body, as, site = 'same-origin', origin, headers = {} } = {}) {
  const h = { 'content-type': 'application/json', ...headers }
  if (site) h['sec-fetch-site'] = site
  if (origin) h.origin = origin
  if (as?.cookie) h.cookie = as.cookie
  if (as?.bearer) h.authorization = 'Bearer ' + as.bearer
  const res = await handleApi(new Request(ORIGIN + path, {
    method, headers: h, ...(body !== undefined ? { body: typeof body === 'string' ? body : JSON.stringify(body) } : {})
  }), env)
  const raw = await res.text()
  let data = null
  try { data = raw ? JSON.parse(raw) : null } catch { data = raw }
  const setCookies = res.headers.getSetCookie ? res.headers.getSetCookie() : []
  const live = setCookies.find(c => /^__Host-gymsid=[^;]+/.test(c) && !/Max-Age=0/.test(c))
  return { status: res.status, body: data, headers: res.headers, setCookies, cookie: live ? live.split(';')[0] : null }
}

// Signs up a password profile and returns its cookie.
export async function signup(env, name, password, code) {
  const r = await call(env, 'POST', '/api/register/password', { body: { name, password, code } })
  if (r.status !== 200) throw new Error(`signup ${name}: ${r.status} ${JSON.stringify(r.body)}`)
  return { cookie: r.cookie, user: r.body.user }
}
