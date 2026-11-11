import { test } from 'node:test'
import assert from 'node:assert/strict'
import { makeEnv, call, signup, ORIGIN } from './helpers.js'
import { writeDoc, readFull, readDocText, PART, KEEP_REVS } from '../src/state.js'

const PW = 'correct horse battery'

test('health and config before anyone signs in', async () => {
  const env = makeEnv()
  assert.deepEqual((await call(env, 'GET', '/api/health')).body, { ok: true, users: 0, writable: true })
  const c = await call(env, 'GET', '/api/config')
  assert.equal(c.status, 200)
  assert.deepEqual(c.body, { invite_only: true, allow_guest: true, password_login: true })
  assert.equal((await call(env, 'GET', '/api/nope')).status, 404)
})

test('refuses to run without a session secret', async () => {
  const env = makeEnv({ SESSION_SECRET: '' })
  const r = await call(env, 'GET', '/api/me')
  assert.equal(r.status, 500)
  assert.match(r.body.error, /SESSION_SECRET/)
})

test('first profile needs the setup code and becomes the owner', async () => {
  const env = makeEnv()
  const bad = await call(env, 'POST', '/api/register/password', { body: { name: 'Akshay', password: PW, code: 'WRONG' } })
  assert.equal(bad.status, 403)
  assert.equal(bad.body.code, 'invite')
  const ok = await call(env, 'POST', '/api/register/password', { body: { name: 'Akshay', password: PW, code: 'setup-code-1' } })
  assert.equal(ok.status, 200)
  assert.equal(ok.body.user.admin, true)
  assert.equal(ok.body.user.owner, true)
  assert.ok(ok.cookie, 'session cookie set')
  assert.ok(ok.setCookies[0].includes('HttpOnly') && ok.setCookies[0].includes('Secure'))
  const me = await call(env, 'GET', '/api/me', { as: { cookie: ok.cookie } })
  assert.equal(me.body.user.name, 'Akshay')
  // The setup code works only while there are no profiles.
  const again = await call(env, 'POST', '/api/register/password', { body: { name: 'Other', password: PW, code: 'SETUP-CODE-1' } })
  assert.equal(again.status, 403)
})

test('friends join with a one-time invite; the password rules apply', async () => {
  const env = makeEnv()
  const owner = await signup(env, 'Akshay', PW, 'SETUP-CODE-1')
  const inv = await call(env, 'POST', '/api/admin/invites/new', { as: owner, body: { note: 'Rahul' } })
  assert.equal(inv.status, 200)
  const code = inv.body.invite.code
  assert.match(code, /^[0-9A-F]{16}$/)
  const weak = await call(env, 'POST', '/api/register/password', { body: { name: 'Rahul', password: 'password123', code } })
  assert.equal(weak.status, 400)
  assert.equal(weak.body.code, 'too-common')
  const friend = await signup(env, 'Rahul', 'squat deep every day', code.toLowerCase())
  assert.equal(friend.user.admin, false)
  const reuse = await call(env, 'POST', '/api/register/password', { body: { name: 'Third', password: PW, code } })
  assert.equal(reuse.status, 403)
  const list = await call(env, 'GET', '/api/admin/invites', { as: owner })
  assert.equal(list.body.invites[0].usedByName, 'Rahul')
  // Not an admin: no dashboard.
  assert.equal((await call(env, 'GET', '/api/admin/users', { as: friend })).status, 403)
  const users = await call(env, 'GET', '/api/admin/users', { as: owner })
  assert.deepEqual(users.body.users.map(u => u.name), ['Akshay', 'Rahul'])
  // The same name cannot be taken twice by password profiles.
  const inv2 = (await call(env, 'POST', '/api/admin/invites/new', { as: owner, body: {} })).body.invite.code
  const dup = await call(env, 'POST', '/api/register/password', { body: { name: 'rahul', password: PW, code: inv2 } })
  assert.equal(dup.status, 409)
  assert.equal(dup.body.code, 'name-taken')
})

test('password sign-in, wrong passwords pause, sign out', async () => {
  const env = makeEnv()
  await signup(env, 'Akshay', PW, 'SETUP-CODE-1')
  const ok = await call(env, 'POST', '/api/login/password', { body: { identifier: 'akshay', password: PW } })
  assert.equal(ok.status, 200)
  assert.ok(ok.cookie)
  for (let i = 0; i < 5; i++) {
    const r = await call(env, 'POST', '/api/login/password', { body: { identifier: 'Akshay', password: 'wrong password ' + i } })
    assert.equal(r.status, 401)
    assert.equal(r.body.code, 'bad-credentials')
  }
  const paused = await call(env, 'POST', '/api/login/password', { body: { identifier: 'Akshay', password: PW } })
  assert.equal(paused.status, 429)
  assert.ok(Number(paused.headers.get('retry-after')) > 0)
  // An unknown name answers like a wrong password.
  assert.equal((await call(env, 'POST', '/api/login/password', { body: { identifier: 'nobody', password: PW }, headers: { 'cf-connecting-ip': '1.2.3.4' } })).status, 401)
  const out = await call(env, 'POST', '/api/logout', { as: { cookie: ok.cookie } })
  assert.equal(out.status, 200)
  assert.ok(out.setCookies.every(c => c.includes('Max-Age=0')))
})

test('a burst of parallel guesses is counted, not waved through', async () => {
  const env = makeEnv()
  await signup(env, 'Akshay', PW, 'SETUP-CODE-1')
  // 40 wrong guesses sent at once against one name, from one address.
  const burst = await Promise.all(Array.from({ length: 40 }, (_, i) =>
    call(env, 'POST', '/api/login/password', { body: { identifier: 'Akshay', password: 'guess number ' + i } })))
  const blocked = burst.filter(r => r.status === 429).length
  assert.ok(blocked >= 30, `most of the burst should be paused, got ${blocked}/40 blocked`)
  // The correct password is refused too while the pause stands.
  assert.equal((await call(env, 'POST', '/api/login/password', { body: { identifier: 'Akshay', password: PW } })).status, 429)
})

test('one invite cannot make two profiles even under a burst', async () => {
  const env = makeEnv()
  const owner = await signup(env, 'Akshay', PW, 'SETUP-CODE-1')
  const code = (await call(env, 'POST', '/api/admin/invites/new', { as: owner, body: {} })).body.invite.code
  const burst = await Promise.all(Array.from({ length: 15 }, (_, i) =>
    call(env, 'POST', '/api/register/password', { body: { name: 'Friend' + i, password: 'squat deep every day', code } })))
  assert.equal(burst.filter(r => r.status === 200).length, 1, 'exactly one sign-up succeeds')
  assert.equal(env.DB.sqlite.prepare('SELECT COUNT(*) AS n FROM users').get().n, 2)
})

test('a too-short setup code is ignored, and wrong codes get throttled', async () => {
  const env = makeEnv({ SETUP_CODE: 'short' })
  const r = await call(env, 'POST', '/api/register/password', { body: { name: 'Akshay', password: PW, code: 'short' } })
  assert.equal(r.status, 403)
  // Guessing sign-up codes is paused after enough misses.
  const env2 = makeEnv()
  let sawPause = false
  for (let i = 0; i < 14; i++) {
    const g = await call(env2, 'POST', '/api/register/options', { body: { name: 'x', code: 'GUESS' + i } })
    if (g.status === 429) { sawPause = true; break }
  }
  assert.ok(sawPause, 'wrong setup-code guesses should start to pause')
})

test('the /64 is what an address is counted by', async () => {
  const { limitAddress } = await import('../src/repo.js')
  assert.equal(limitAddress('203.0.113.9'), '203.0.113.9')
  assert.equal(limitAddress('::ffff:203.0.113.9'), '203.0.113.9')
  assert.equal(limitAddress('2001:db8:abcd:1234:5678:9abc:def0:1'), '2001:db8:abcd:1234::/64')
  assert.equal(limitAddress('2001:db8::1'), '2001:db8:0:0::/64')
  assert.equal(limitAddress('garbage'), 'unknown')
})

test('a write from another site is refused, a same-origin one is not', async () => {
  const env = makeEnv()
  const owner = await signup(env, 'Akshay', PW, 'SETUP-CODE-1')
  const forged = await call(env, 'POST', '/api/logout/all', { as: owner, site: 'cross-site', origin: 'https://evil.example' })
  assert.equal(forged.status, 403)
  assert.equal(forged.body.code, 'origin-mismatch')
  const sibling = await call(env, 'POST', '/api/logout/all', { as: owner, site: 'same-site' })
  assert.equal(sibling.status, 403)
  // No Sec-Fetch-Site (older Safari): the Origin header decides.
  assert.equal((await call(env, 'POST', '/api/logout/all', { as: owner, site: null, origin: 'https://evil.example' })).status, 403)
  assert.equal((await call(env, 'POST', '/api/logout/all', { as: owner, site: null, origin: ORIGIN })).status, 200)
})

test('sync: empty profile, write, read back, stale write gets 409 with the current document', async () => {
  const env = makeEnv()
  const me = await signup(env, 'Akshay', PW, 'SETUP-CODE-1')
  const empty = await call(env, 'GET', '/api/data', { as: me })
  assert.deepEqual(empty.body, { state: null, rev: 0 })
  assert.deepEqual((await call(env, 'GET', '/api/data/rev', { as: me })).body, { rev: 0 })

  const state = { workouts: [{ id: 'w1', d: '2026-11-10', name: 'Push', ex: [] }], routines: [], settings: { unit: 'kg' }, active: { id: 'live' } }
  const put = await call(env, 'PUT', '/api/data', { as: me, body: { state, baseRev: 0, stamped: true } })
  assert.equal(put.status, 200, JSON.stringify(put.body))
  assert.equal(put.body.rev, 1)
  assert.match(put.body.wid, /^[0-9a-f]{16}$/)

  const got = await call(env, 'GET', '/api/data', { as: me })
  assert.equal(got.body.rev, 1)
  assert.equal(got.body.state._rev, 1)
  assert.equal(got.body.state.workouts[0].name, 'Push')
  assert.equal(got.body.state.active, undefined, 'the workout in progress stays on the device')
  assert.equal((await call(env, 'GET', '/api/data/rev', { as: me })).body.wid, put.body.wid)

  const stale = await call(env, 'PUT', '/api/data', { as: me, body: { state, baseRev: 0, stamped: true } })
  assert.equal(stale.status, 409)
  assert.equal(stale.body.rev, 1)
  assert.equal(stale.body.state.workouts.length, 1)
  assert.equal(stale.body.state._prior, undefined, 'server notes never go to a client')

  // Profiles never see each other's data.
  const owner = me
  const code = (await call(env, 'POST', '/api/admin/invites/new', { as: owner, body: {} })).body.invite.code
  const friend = await signup(env, 'Rahul', 'squat deep every day', code)
  assert.deepEqual((await call(env, 'GET', '/api/data', { as: friend })).body, { state: null, rev: 0 })
})

test('sync refuses documents that would wipe the profile', async () => {
  const env = makeEnv()
  const me = await signup(env, 'Akshay', PW, 'SETUP-CODE-1')
  for (const state of [{}, { _rev: 5 }, [], { workouts: 'x' }]) {
    const r = await call(env, 'PUT', '/api/data', { as: me, body: { state } })
    assert.equal(r.status, 400, JSON.stringify(state))
  }
  assert.equal((await call(env, 'PUT', '/api/data', { as: me, body: '{not json' })).status, 400)
  assert.equal((await call(env, 'PUT', '/api/data', { body: { state: { workouts: [] } } })).status, 401)
})

test('two writes over the same revision: exactly one wins', async () => {
  const env = makeEnv()
  const db = env.DB
  assert.equal(await writeDoc(db, 'u1', 0, 1, { workouts: [], a: 1 }), true)
  assert.equal(await writeDoc(db, 'u1', 0, 1, { workouts: [], a: 2 }), false)
  const { meta, doc } = await readFull(db, 'u1')
  assert.equal(meta.rev, 1)
  assert.equal(doc.a, 1)
})

test('a document bigger than one D1 row is split and read back whole; old revisions are pruned', async () => {
  const env = makeEnv()
  const db = env.DB
  const big = { workouts: Array.from({ length: 4000 }, (_, i) => ({ id: 'w' + i, d: '2026-01-01', note: 'é💪'.repeat(80) + i })), _prior: { x: [1] } }
  const size = JSON.stringify(big).length
  assert.ok(size > 2 * PART, 'test document spans several parts: ' + size)
  let rev = 0
  for (let i = 0; i < KEEP_REVS + 3; i++) { assert.equal(await writeDoc(db, 'u1', rev, rev + 1, big), true); rev++ }
  const { meta, doc } = await readFull(db, 'u1')
  assert.equal(meta.rev, rev)
  assert.equal(meta.workouts, 4000)
  assert.deepEqual(doc, big)
  const revs = db.sqlite.prepare('SELECT DISTINCT rev FROM state_parts WHERE uid = ?').all('u1').map(r => r.rev)
  assert.equal(revs.length, KEEP_REVS)
  const notesParts = db.sqlite.prepare("SELECT COUNT(*) AS n FROM state_parts WHERE uid = ? AND rev = ? AND kind = 'notes'").get('u1', rev).n
  assert.equal(notesParts, 1)
})

test('an emoji on a part boundary survives the split', async () => {
  const env = makeEnv()
  const db = env.DB
  // A note of emojis whose length makes a surrogate pair straddle offset PART exactly.
  const filler = 'a'.repeat(PART - 1)
  const doc = { workouts: [{ id: 'w1', d: '2026-01-01', note: filler + '💪🏋️🤸' + 'z'.repeat(10) }] }
  assert.equal(await writeDoc(db, 'u1', 0, 1, doc), true)
  const { text } = await readDocText(db, 'u1')
  const back = JSON.parse(text)
  assert.equal(back.workouts[0].note, doc.workouts[0].note, 'the note reads back unchanged')
  assert.ok(!back.workouts[0].note.includes('�'), 'no replacement characters')
})

test('phone pairing: code from the browser, token for the phone, CORS for its origin', async () => {
  const env = makeEnv()
  const me = await signup(env, 'Akshay', PW, 'SETUP-CODE-1')
  const noProof = await call(env, 'POST', '/api/pair/create', { as: me, body: {} })
  assert.equal(noProof.status, 403)
  assert.equal(noProof.body.code, 'current-required')
  const created = await call(env, 'POST', '/api/pair/create', { as: me, body: { current: PW } })
  assert.equal(created.status, 200)
  assert.match(created.body.code, /^[A-HJ-NP-Z2-9]{8}$/)

  const phone = 'https://localhost'
  const pre = await call(env, 'OPTIONS', '/api/pair/redeem', { site: 'cross-site', origin: phone })
  assert.equal(pre.status, 204)
  assert.equal(pre.headers.get('access-control-allow-origin'), phone)
  assert.equal(pre.headers.get('access-control-allow-credentials'), null)

  const redeemed = await call(env, 'POST', '/api/pair/redeem', { body: { code: created.body.code.toLowerCase() }, site: 'cross-site', origin: phone })
  assert.equal(redeemed.status, 200)
  assert.equal(redeemed.headers.get('access-control-allow-origin'), phone)
  const token = redeemed.body.token
  assert.ok(token)
  // One-shot.
  assert.equal((await call(env, 'POST', '/api/pair/redeem', { body: { code: created.body.code }, site: 'cross-site', origin: phone })).status, 400)

  const tablet = { bearer: token }
  const put = await call(env, 'PUT', '/api/data', { as: tablet, body: { state: { workouts: [], routines: [{ id: 'r1', name: 'Legs' }] }, baseRev: 0 }, site: 'cross-site', origin: phone })
  assert.equal(put.status, 200, JSON.stringify(put.body))
  assert.equal((await call(env, 'GET', '/api/data', { as: me })).body.state.routines[0].name, 'Legs')

  // "Sign out everywhere" ends the phone's token too.
  assert.equal((await call(env, 'POST', '/api/logout/all', { as: me })).status, 200)
  assert.equal((await call(env, 'GET', '/api/data', { as: tablet, site: 'cross-site', origin: phone })).status, 401)
  assert.equal((await call(env, 'PUT', '/api/data', { as: tablet, body: { state: { workouts: [] } }, site: 'cross-site', origin: phone })).status, 401)
})

test('a tampered or foreign token is not a session', async () => {
  const env = makeEnv()
  const me = await signup(env, 'Akshay', PW, 'SETUP-CODE-1')
  const tok = me.cookie.split('=')[1]
  const [payload] = tok.split('.')
  const forged = payload.replace(/:0:c$/, ':0:b') + '.' + tok.split('.')[1]
  assert.equal((await call(env, 'GET', '/api/me', { as: { bearer: forged } })).status, 401)
  const other = makeEnv({ SESSION_SECRET: 'z'.repeat(48) })
  other.DB = env.DB
  assert.equal((await call(other, 'GET', '/api/me', { as: me })).status, 401)
})

test('passkey ceremonies hand out options for this host', async () => {
  const env = makeEnv()
  const reg = await call(env, 'POST', '/api/register/options', { body: { name: 'Akshay', code: 'SETUP-CODE-1' } })
  assert.equal(reg.status, 200)
  assert.equal(reg.body.options.rp.id, 'gym.test')
  assert.equal(reg.body.options.authenticatorSelection.residentKey, 'required')
  assert.ok(reg.body.cid)
  assert.equal((await call(env, 'POST', '/api/register/options', { body: { name: 'Akshay', code: 'nope' } })).status, 403)
  const login = await call(env, 'POST', '/api/login/options', { body: {} })
  assert.equal(login.body.options.rpId, 'gym.test')
  // A challenge is one-shot and of one kind only.
  const v = await call(env, 'POST', '/api/register/verify', { body: { cid: login.body.cid, credential: {} } })
  assert.equal(v.body.code, 'challenge-expired')
  const v2 = await call(env, 'POST', '/api/login/verify', { body: { cid: login.body.cid, credential: { id: 'x' } } })
  assert.equal(v2.body.code, 'challenge-expired')
})

test('password settings and deleting the profile', async () => {
  const env = makeEnv()
  const owner = await signup(env, 'Akshay', PW, 'SETUP-CODE-1')
  const code = (await call(env, 'POST', '/api/admin/invites/new', { as: owner, body: {} })).body.invite.code
  let friend = await signup(env, 'Rahul', 'squat deep every day', code)

  const info = await call(env, 'GET', '/api/account/password', { as: friend })
  assert.equal(info.body.set, true)
  assert.equal(info.body.passkeys, 0)
  // The only way in cannot be removed.
  assert.equal((await call(env, 'DELETE', '/api/account/password', { as: friend, body: { current: 'squat deep every day' } })).body.code, 'last-way-in')

  const changed = await call(env, 'POST', '/api/account/password', { as: friend, body: { current: 'squat deep every day', next: 'bench press forever' } })
  assert.equal(changed.status, 200)
  assert.equal((await call(env, 'GET', '/api/me', { as: friend })).status, 401, 'old cookie ended by the change')
  friend = { cookie: changed.cookie }
  assert.equal((await call(env, 'GET', '/api/me', { as: friend })).status, 200)

  // The last admin cannot leave while others remain.
  const blocked = await call(env, 'POST', '/api/account/delete', { as: owner, body: { name: 'Akshay', current: PW } })
  assert.equal(blocked.body.code, 'last-admin')
  assert.equal((await call(env, 'GET', '/api/account/passkeys', { as: owner })).body.deleteBlocked, 'last-admin')

  await call(env, 'PUT', '/api/data', { as: friend, body: { state: { workouts: [{ id: 'a', d: '2026-11-11' }] }, baseRev: 0 } })
  assert.equal((await call(env, 'POST', '/api/account/delete', { as: friend, body: { name: 'wrong', current: 'bench press forever' } })).body.code, 'confirm-name')
  const gone = await call(env, 'POST', '/api/account/delete', { as: friend, body: { name: 'Rahul', current: 'bench press forever' } })
  assert.equal(gone.status, 200)
  assert.equal((await call(env, 'GET', '/api/me', { as: friend })).status, 401)
  const left = env.DB.sqlite.prepare('SELECT (SELECT COUNT(*) FROM state_parts) AS p, (SELECT COUNT(*) FROM users) AS u').get()
  assert.deepEqual({ ...left }, { p: 0, u: 1 })
})

test('stubs for features this server does not run', async () => {
  const env = makeEnv()
  const me = await signup(env, 'Akshay', PW, 'SETUP-CODE-1')
  assert.deepEqual((await call(env, 'GET', '/api/watch/events', { as: me })).body, { events: [], paired: 0, seen: 0 })
  assert.equal((await call(env, 'POST', '/api/activity', { as: me, body: { active: true } })).status, 200)
  assert.equal((await call(env, 'GET', '/api/config', { as: me })).body.coach, null)
  assert.equal((await call(env, 'GET', '/api/push/public-key', { as: me })).status, 404)
})
