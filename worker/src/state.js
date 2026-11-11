// Each profile's training document in D1. A D1 row holds at most 2 MB, so the document is stored
// in parts; each write is a new revision, and the last KEEP_REVS revisions stay as a backup trail.
//
// What clients get ('doc') and the server's own notes ('notes': `_unstamped`, `_prior`, see
// api/sync-stamps.js) are stored apart, so GET /api/data can send the document as stored, without
// parsing it.
import { HttpError } from './http.js'

// Characters per part. UTF-8 needs at most 3 bytes per UTF-16 unit, so a part stays under 2 MB.
export const PART = 500000
export const KEEP_REVS = 10

// Never between a surrogate pair, or an emoji at a part boundary would read back as two U+FFFD.
const split = s => {
  const out = []
  for (let i = 0; i < s.length;) {
    let end = Math.min(i + PART, s.length)
    if (end < s.length) { const c = s.charCodeAt(end); if (c >= 0xDC00 && c <= 0xDFFF) end-- }
    out.push(s.slice(i, end))
    i = end
  }
  return out.length ? out : ['']
}

export async function readMeta(db, uid) {
  return db.prepare('SELECT * FROM state_meta WHERE uid = ?').bind(uid).first()
}

async function readText(db, uid, rev, kind) {
  const { results } = await db.prepare('SELECT body FROM state_parts WHERE uid = ? AND rev = ? AND kind = ? ORDER BY idx').bind(uid, rev, kind).all()
  return results && results.length ? results.map(r => r.body).join('') : null
}

// The client's copy as stored text (no parse), or null for a profile with no document yet.
export async function readDocText(db, uid) {
  const meta = await readMeta(db, uid)
  if (!meta) return { meta: null, text: null }
  const text = await readText(db, uid, meta.rev, 'doc')
  if (text == null) throw new HttpError(503, 'state unreadable')
  return { meta, text }
}

// The whole stored document, the server's notes put back in, for PUT /api/data's merge.
export async function readFull(db, uid) {
  const { meta, text } = await readDocText(db, uid)
  if (!meta) return { meta: null, doc: null }
  let doc, notes
  try {
    doc = JSON.parse(text)
    const n = await readText(db, uid, meta.rev, 'notes')
    notes = n ? JSON.parse(n) : null
  } catch { throw new HttpError(503, 'state unreadable') }
  if (notes && typeof notes === 'object' && doc && typeof doc === 'object') Object.assign(doc, notes)
  return { meta, doc }
}

// Writes `doc` as revision `rev` over `baseRev` in one transaction. Returns false when another
// write over the same base revision got there first (the caller answers 409).
export async function writeDoc(db, uid, baseRev, rev, doc) {
  const { _unstamped, _prior, ...client } = doc
  const notes = {}
  if (_unstamped !== undefined) notes._unstamped = _unstamped
  if (_prior !== undefined) notes._prior = _prior
  const docText = JSON.stringify(client)
  const docParts = split(docText)
  const noteParts = Object.keys(notes).length ? split(JSON.stringify(notes)) : []
  const workouts = Array.isArray(client.workouts) ? client.workouts : []
  const last = workouts.length ? workouts[workouts.length - 1] : null
  const now = Date.now()

  const ins = db.prepare('INSERT INTO state_parts (uid, rev, kind, idx, body) VALUES (?, ?, ?, ?, ?)')
  const stmts = [
    // The guard: a second write over the same base revision fails on this key, rolling back all.
    db.prepare('INSERT INTO state_writes (uid, base_rev, at) VALUES (?, ?, ?)').bind(uid, baseRev, now),
    // A retried write after a failed one may find its own parts from that attempt.
    db.prepare('DELETE FROM state_parts WHERE uid = ? AND rev = ?').bind(uid, rev),
    ...docParts.map((p, i) => ins.bind(uid, rev, 'doc', i, p)),
    ...noteParts.map((p, i) => ins.bind(uid, rev, 'notes', i, p)),
    db.prepare(`INSERT OR REPLACE INTO state_meta (uid, rev, wid, parts, bytes, updated, workouts, last_workout)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
      .bind(uid, rev, client._wid || null, docParts.length, docText.length, now, workouts.length, (last && typeof last.d === 'string') ? last.d : null),
    db.prepare(`DELETE FROM state_parts WHERE uid = ? AND rev NOT IN
                (SELECT DISTINCT rev FROM state_parts WHERE uid = ? ORDER BY rev DESC LIMIT ?)`).bind(uid, uid, KEEP_REVS),
    db.prepare('DELETE FROM state_writes WHERE uid = ? AND base_rev < ?').bind(uid, baseRev - 100)
  ]
  try { await db.batch(stmts) }
  catch (e) {
    if (/UNIQUE|constraint/i.test(String(e && e.message))) return false
    throw e
  }
  return true
}
