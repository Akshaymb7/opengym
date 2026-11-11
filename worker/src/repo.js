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
    // Everything of an account: the record, its passkeys, codes and its whole training history.
    async deleteUser(id) {
      await db.batch([
        db.prepare('DELETE FROM users WHERE id = ?').bind(id),
        db.prepare('DELETE FROM creds WHERE user_id = ?').bind(id),
        db.prepare('DELETE FROM pairings WHERE uid = ?').bind(id),
        db.prepare('DELETE FROM state_parts WHERE uid = ?').bind(id),
        db.prepare('DELETE FROM state_meta WHERE uid = ?').bind(id),
        db.prepare('DELETE FROM state_writes WHERE uid = ?').bind(id)
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

    /* wrong-password pauses */
    async throttleRow(key) { return one('SELECT fails, until FROM throttle WHERE key = ?', key) },
    async throttleSet(key, fails, until) {
      await run('INSERT OR REPLACE INTO throttle (key, fails, until, updated) VALUES (?, ?, ?, ?)', key, fails, until, Date.now())
    },
    async throttleClear(key) { await run('DELETE FROM throttle WHERE key = ?', key) }
  }
  return r
}

// Sign-in pauses: a few free tries, then 30 s doubling up to 15 minutes. Counted per account and
// per address (CF-Connecting-IP), checked before the hash is computed.
const FREE = 5
const MAX_WAIT_MS = 15 * 60000
export async function throttleWait(repo, keys) {
  let wait = 0
  for (const k of keys) {
    const row = await repo.throttleRow(k)
    if (row && row.until > Date.now()) wait = Math.max(wait, row.until - Date.now())
  }
  return Math.ceil(wait / 1000)
}
export async function throttleFail(repo, key) {
  const row = await repo.throttleRow(key)
  const fails = (row?.fails || 0) + 1
  const until = fails >= FREE ? Date.now() + Math.min(MAX_WAIT_MS, 30000 * 2 ** (fails - FREE)) : 0
  await repo.throttleSet(key, fails, until)
}
