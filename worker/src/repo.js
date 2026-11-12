// D1 access for accounts and short-lived codes. Records are the JSON shapes api/server.js keeps in
// db.json, so the shared helpers in ../api work on them unchanged.
import { randomId, readableCode } from './http.js'

const parse = r => (r ? JSON.parse(r.data) : null)
const TTL_MS = 5 * 60000

export function makeRepo(db) {
  const one = (sql, ...args) => db.prepare(sql).bind(...args).first()
  const all = async (sql, ...args) => (await db.prepare(sql).bind(...args).all()).results || []
  const run = (sql, ...args) => db.prepare(sql).bind(...args).run()

  const r = {
    db,
    /* users */
    async users() { return (await all('SELECT data FROM users ORDER BY created, id')).map(parse) },
    async user(id) { return id ? parse(await one('SELECT data FROM users WHERE id = ?', id)) : null },
    async userCount() { return (await one('SELECT COUNT(*) AS n FROM users')).n },
    saveUserStmt(u) { return db.prepare('INSERT OR REPLACE INTO users (id, data, created) VALUES (?, ?, ?)').bind(u.id, JSON.stringify(u), u.created || new Date().toISOString()) },
    async saveUser(u) { await r.saveUserStmt(u).run() },
    // Everything of an account: the record, its passkeys, codes, its whole training history and meals.
    async deleteUser(id) {
      await db.batch([
        db.prepare('DELETE FROM users WHERE id = ?').bind(id),
        db.prepare('DELETE FROM creds WHERE user_id = ?').bind(id),
        db.prepare('DELETE FROM pairings WHERE uid = ?').bind(id),
        db.prepare('DELETE FROM state_parts WHERE uid = ?').bind(id),
        db.prepare('DELETE FROM state_meta WHERE uid = ?').bind(id),
        db.prepare('DELETE FROM state_writes WHERE uid = ?').bind(id),
        db.prepare('DELETE FROM meals WHERE uid = ?').bind(id),
        db.prepare('DELETE FROM meal_prefs WHERE uid = ?').bind(id),
        db.prepare('DELETE FROM ai_usage WHERE uid = ?').bind(id)
      ])
    },

    /* passkeys */
    async credsOf(uid) { return (await all('SELECT data FROM creds WHERE user_id = ? ORDER BY rowid', uid)).map(parse) },
    async cred(id) { return id ? parse(await one('SELECT data FROM creds WHERE id = ?', String(id))) : null },
    saveCredStmt(c) { return db.prepare('INSERT OR REPLACE INTO creds (id, user_id, data) VALUES (?, ?, ?)').bind(c.id, c.userId, JSON.stringify(c)) },
    async saveCred(c) { await r.saveCredStmt(c).run() },
    async deleteCred(id) { await run('DELETE FROM creds WHERE id = ?', id) },
    async credCount(uid) { return (await one('SELECT COUNT(*) AS n FROM creds WHERE user_id = ?', uid)).n },

    /* invites */
    async invites() { return (await all('SELECT data FROM invites ORDER BY rowid')).map(parse) },
    async invite(code) { return code ? parse(await one('SELECT data FROM invites WHERE code = ?', code)) : null },
    saveInviteStmt(i) { return db.prepare('INSERT OR REPLACE INTO invites (code, data) VALUES (?, ?)').bind(i.code, JSON.stringify(i)) },
    async saveInvite(i) { await r.saveInviteStmt(i).run() },
    async deleteInvite(code) { await run('DELETE FROM invites WHERE code = ?', code) },

    /* WebAuthn challenges: one-shot, 5 minutes */
    async putChallenge(data) {
      const cid = randomId(16)
      await run('INSERT INTO challenges (cid, data, exp) VALUES (?, ?, ?)', cid, JSON.stringify(data), Date.now() + TTL_MS)
      // Housekeeping rides along: nothing else would ever clear the expired ones.
      await run('DELETE FROM challenges WHERE exp < ?', Date.now())
      await r.throttleSweep()
      return cid
    },
    async takeChallenge(cid) {
      if (!cid || typeof cid !== 'string') return null
      const row = await one('DELETE FROM challenges WHERE cid = ? RETURNING data, exp', cid)
      if (!row || row.exp < Date.now()) return null
      return JSON.parse(row.data)
    },

    /* phone pairing codes: one live code per profile, one-shot, 5 minutes */
    async putPairing(uid) {
      const code = readableCode(8)
      await db.batch([
        db.prepare('DELETE FROM pairings WHERE uid = ? OR exp < ?').bind(uid, Date.now()),
        db.prepare('INSERT INTO pairings (code, uid, exp) VALUES (?, ?, ?)').bind(code, uid, Date.now() + TTL_MS)
      ])
      return code
    },
    async takePairing(code) {
      if (!code) return null
      const row = await one('DELETE FROM pairings WHERE code = ? RETURNING uid, exp', code)
      return row && row.exp >= Date.now() ? row.uid : null
    },
    async dropPairings(uid) { await run('DELETE FROM pairings WHERE uid = ?', uid) },

    /* attempt counters (wrong passwords, wrong sign-up codes) */
    // One attempt, counted atomically BEFORE the work it guards, so attempts sent side by side
    // cannot all start under the same allowance. Returns { fails, until }: `until` in the future
    // means paused (the attempt was not counted then). A counter quiet for `forgetMs` starts over.
    async throttleHit(key, { free, forgetMs }) {
      return one(`INSERT INTO throttle (key, fails, until, updated) VALUES (?1, 1, 0, ?2)
        ON CONFLICT(key) DO UPDATE SET
          fails = CASE WHEN throttle.until > ?2 THEN throttle.fails
                       WHEN ?2 - MAX(throttle.updated, throttle.until) > ?3 THEN 1
                       ELSE throttle.fails + 1 END,
          until = CASE WHEN throttle.until > ?2 THEN throttle.until
                       WHEN ?2 - MAX(throttle.updated, throttle.until) > ?3 THEN 0
                       WHEN throttle.fails + 1 > ?4 THEN ?2 + MIN(?5, 30000 * (1 << MIN(throttle.fails - ?4, 10)))
                       ELSE 0 END,
          updated = CASE WHEN throttle.until > ?2 THEN throttle.updated ELSE ?2 END
        RETURNING fails, until`, key, Date.now(), forgetMs, free, MAX_WAIT_MS)
    },
    async throttleRow(key) { return one('SELECT fails, until FROM throttle WHERE key = ?', key) },
    // A right answer gives the attempt back.
    async throttleUndo(key) { await run('UPDATE throttle SET fails = MAX(fails - 1, 0) WHERE key = ? AND until <= ?', key, Date.now()) },
    async throttleClear(key) { await run('DELETE FROM throttle WHERE key = ?', key) },
    async throttleSweep() { await run('DELETE FROM throttle WHERE until < ?1 AND updated < ?1 - ?2', Date.now(), DAY_MS) }
  }
  return r
}

// Pauses: a few free attempts, then 30 s doubling up to 15 minutes; forgotten after a quiet spell.
// Per account (5 free, a day) and per address (20 free, an hour), as in api/server.js.
const MAX_WAIT_MS = 15 * 60000
const DAY_MS = 24 * 3600000
export const LIMITS = {
  account: { free: 5, forgetMs: DAY_MS },
  address: { free: 20, forgetMs: 3600000 },
  signup: { free: 10, forgetMs: 3600000 }
}
// Counts one attempt on every key; resolves to the seconds to wait (0 = go ahead).
export async function throttleAttempt(repo, hits) {
  let wait = 0
  for (const [key, limit] of hits) {
    const row = await repo.throttleHit(key, limit)
    if (row.until > Date.now()) wait = Math.max(wait, row.until - Date.now())
  }
  return Math.ceil(wait / 1000)
}

// The address an attempt is counted against: an IPv6 address by its /64 (one connection's whole
// prefix), an IPv4-mapped IPv6 as the IPv4 address (api/server.js limitAddress).
export function limitAddress(raw) {
  const ip = String(raw || '').trim().toLowerCase()
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(ip)) return ip
  const mapped = /^::ffff:(\d{1,3}(\.\d{1,3}){3})$/.exec(ip)
  if (mapped) return mapped[1]
  if (!ip.includes(':') || !/^[0-9a-f:]+$/.test(ip)) return 'unknown'
  const [head, tail = ''] = ip.split('::')
  const a = head ? head.split(':') : []
  const b = tail ? tail.split(':') : []
  const groups = ip.includes('::') ? [...a, ...Array(Math.max(0, 8 - a.length - b.length)).fill('0'), ...b] : a
  return groups.slice(0, 4).map(g => g.replace(/^0+(?=.)/, '')).join(':') + '::/64'
}
