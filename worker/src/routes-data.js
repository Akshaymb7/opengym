// Sync (the profile's document), the admin dashboard's users and invites, and the small routes the
// app polls. The document logic is api/server.js's PUT /api/data, with api/sync-stamps.js as is.
import { stampPut } from '../../api/sync-stamps.js'
import { json, rawJson, readBody, text, randomHex, HttpError } from './http.js'
import { readSession } from './session.js'
import { notSignedIn, requireAdmin, isAdmin, isOwner, hasPassword } from './auth.js'
import { readMeta, readDocText, readFull, writeDoc } from './state.js'

const WID_KEEP = 50
const record = x => !!x && typeof x === 'object' && !Array.isArray(x)
const records = v => (Array.isArray(v) ? v.filter(record) : [])
const forClient = S => {
  if (!S || typeof S !== 'object' || !('_unstamped' in S || '_prior' in S)) return S
  const { _unstamped, _prior, ...rest } = S
  return rest
}

// One attempt at the conditional write. { res } when answered, { retry } when another write over
// the same revision won the race and this one carried no baseRev (a plain overwrite).
async function putOnce(ctx, user, body) {
  const { db } = ctx
  const { meta, doc: cur } = await readFull(db, user.id)
  const curRev = meta?.rev || 0
  if ((body.baseRev != null && body.baseRev !== curRev) ||
      (body.baseRev != null && typeof body.baseWid === 'string' && cur?._wid && body.baseWid !== cur._wid)) {
    return { res: json(409, { error: 'conflict', rev: curRev, state: forClient(cur) }) }
  }
  const next = structuredClone(body.state)
  delete next.active // in-progress workouts stay on the device
  // "Reset everything" only moves forward.
  const storedReset = Number(cur?.resetAt) || 0
  if (storedReset > (Number(next.resetAt) || 0)) {
    next.resetAt = cur.resetAt
    if (cur.resetIds && typeof cur.resetIds === 'object') next.resetIds = cur.resetIds
    else delete next.resetIds
  }
  const report = {}
  try { stampPut(cur, next, { overRead: body.baseRev != null && body.baseRev === curRev, stamped: body.stamped === true, report }) }
  catch (e) { if (e instanceof RangeError) return { res: json(400, { error: 'invalid state' }) }; throw e }
  next._rev = curRev + (report.changed ? 2 : 1)
  next._wids = [...(Array.isArray(cur?._wids) ? cur._wids : []), ...(cur?._wid ? [cur._wid] : [])]
    .filter(x => typeof x === 'string').slice(-WID_KEEP)
  next._wid = randomHex(8)
  let ok
  try { ok = await writeDoc(db, user.id, curRev, next._rev, next) }
  catch (e) { if (e instanceof RangeError) return { res: json(400, { error: 'invalid state' }) }; throw e }
  if (!ok) {
    if (body.baseRev != null) {
      const now = await readFull(db, user.id)
      return { res: json(409, { error: 'conflict', rev: now.meta?.rev || 0, state: forClient(now.doc) }) }
    }
    return { retry: true }
  }
  // As api/server.js: the writer is told the next revision even when the server stored one further.
  return { res: json(200, { ok: true, ts: next._ts || null, rev: curRev + 1, wid: next._wid }) }
}

export const dataRoutes = {
  // Sent as stored: the document is never parsed on the way out.
  'GET /api/data': async ctx => {
    const user = await readSession(ctx)
    if (!user) return notSignedIn()
    const { meta, text: doc } = await readDocText(ctx.db, user.id)
    if (!meta) return json(200, { state: null, rev: 0 })
    return rawJson(200, `{"state":${doc},"rev":${meta.rev}}`)
  },

  // Asked every half minute while the app is open; the document is fetched only when this moved.
  'GET /api/data/rev': async ctx => {
    const user = await readSession(ctx)
    if (!user) return notSignedIn()
    const meta = await readMeta(ctx.db, user.id)
    return json(200, { rev: meta?.rev || 0, ...(meta?.wid ? { wid: meta.wid } : {}) })
  },

  'PUT /api/data': async ctx => {
    const user = await readSession(ctx)
    if (!user) return notSignedIn()
    const body = await readBody(ctx.request)
    if (!body.state || typeof body.state !== 'object') return json(400, { error: 'state required' })
    // A document with nothing of the profile in it would wipe it: refused.
    if (!Array.isArray(body.state) && !Object.keys(body.state).some(k => k !== '_rev' && k !== '_ts')) return json(400, { error: 'state required' })
    const list = v => v == null || Array.isArray(v)
    if (Array.isArray(body.state) || !list(body.state.workouts) || !list(body.state.routines)) return json(400, { error: 'invalid state' })
    for (const k of ['workouts', 'routines']) if (Array.isArray(body.state[k])) body.state[k] = records(body.state[k])
    for (let i = 0; i < 3; i++) {
      const r = await putOnce(ctx, user, body)
      if (r.res) return r.res
    }
    throw new HttpError(503, 'busy, try again')
  },

  // Live "who is training" for the admin dashboard: not kept on this server.
  'POST /api/activity': async ctx => {
    if (!(await readSession(ctx))) return notSignedIn()
    await ctx.request.text()
    return json(200, { ok: true })
  },

  // No watch relay on this server: answered as "no watch paired" so the app stops asking.
  'GET /api/watch/events': async ctx => {
    if (!(await readSession(ctx))) return notSignedIn()
    return json(200, { events: [], paired: 0, seen: 0 })
  },

  /* ---------- admin: users and invites ---------- */
  'GET /api/admin/users': async ctx => {
    const a = await requireAdmin(ctx)
    if (a.res) return a.res
    const { cfg, repo, db } = ctx
    const users = await repo.users()
    const { results: metas } = await db.prepare('SELECT uid, updated, workouts, last_workout FROM state_meta').all()
    const byUid = new Map((metas || []).map(m => [m.uid, m]))
    return json(200, {
      users: users.map(u => {
        const m = byUid.get(u.id)
        return {
          id: u.id, name: u.name, created: u.created || null,
          disabled: !!u.disabled, admin: isAdmin(u), owner: isOwner(u), invitedBy: u.invitedBy || null,
          workouts: m?.workouts || 0, lastWorkout: m?.last_workout || null, lastSync: m?.updated || null,
          hasPush: false, live: null,
          ...(cfg.PASSWORD_LOGIN ? { password: hasPassword(u), email: u.email || null } : {})
        }
      }),
      invite_only: cfg.INVITE_ONLY, ...(cfg.PASSWORD_LOGIN ? { password_login: true } : {}), now: Date.now()
    })
  },

  'GET /api/admin/invites': async ctx => {
    const a = await requireAdmin(ctx)
    if (a.res) return a.res
    const users = await ctx.repo.users()
    const nameOf = id => (users.find(u => u.id === id) || {}).name || null
    const invites = (await ctx.repo.invites()).map(i => ({ ...i, usedByName: i.usedBy ? nameOf(i.usedBy) : null }))
    return json(200, { invites, invite_only: ctx.cfg.INVITE_ONLY })
  },

  // 64-bit codes: /api/register/options says whether a code is good, so it must not be guessable.
  'POST /api/admin/invites/new': async ctx => {
    const a = await requireAdmin(ctx)
    if (a.res) return a.res
    const body = await readBody(ctx.request)
    const invite = { code: randomHex(8).toUpperCase(), note: text(body.note).slice(0, 60), createdBy: a.user.id, created: new Date().toISOString() }
    await ctx.repo.saveInvite(invite)
    return json(200, { invite })
  },

  'POST /api/admin/invites/revoke': async ctx => {
    const a = await requireAdmin(ctx)
    if (a.res) return a.res
    const body = await readBody(ctx.request)
    const inv = await ctx.repo.invite(text(body.code).toUpperCase())
    if (!inv) return json(404, { error: 'no such code' })
    if (inv.usedBy) return json(400, { error: 'already used, cannot revoke' })
    await ctx.repo.deleteInvite(inv.code)
    return json(200, { ok: true })
  }
}
