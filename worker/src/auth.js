// Shared account logic for the routes: who is who, invites, proofs of ownership, password checks.
// Ported from api/server.js; same answers and `code`s, which the app translates.
import { verifyAuthenticationResponse } from '@simplewebauthn/server'
import { verifyError, isMisconfigured } from '../../api/verify-error.js'
import { json, text, fromB64u, sameString } from './http.js'
import { readSession, sessionOf } from './session.js'
import { nameKey, verifyPassword } from './password.js'
import { throttleAttempt, limitAddress, LIMITS } from './repo.js'

export const isAdmin = u => !!u && u.admin === true
export const isOwner = u => isAdmin(u) && u.owner === true
export const publicUser = u => ({ id: u.id, name: u.name, admin: isAdmin(u), ...(isOwner(u) ? { owner: true } : {}) })

export const hasPassword = u => !!(u && u.pw && typeof u.pw.h === 'string')
export const passwordWayIn = (cfg, u) => cfg.PASSWORD_LOGIN && hasPassword(u)

export const notSignedIn = () => json(401, { error: 'not signed in' })
export const WRONG = { error: 'wrong name or password', code: 'bad-credentials' }

// A verify error as an answer: a passkey made at another address gets the origin-mismatch code.
export const verifyAnswer = (cfg, e) => ({
  error: verifyError(e, { rpId: cfg.RP_ID, origin: cfg.ORIGIN }),
  ...(isMisconfigured(e) ? { code: 'origin-mismatch', expected: cfg.ORIGIN } : {})
})

export async function requireUser(ctx) {
  const user = await readSession(ctx)
  return user ? { user } : { res: notSignedIn() }
}

export async function requireAdmin(ctx) {
  const user = await readSession(ctx)
  if (!user) return { res: notSignedIn() }
  if (!isAdmin(user)) return { res: json(403, { error: 'forbidden' }) }
  return { user }
}

// Whether `code` lets a new profile in. On an invite-only instance with no profile yet, only the
// SETUP_CODE secret does (nobody exists to make an invite); after that, an unused invite.
// Returns { first, invite } or null.
export async function signupGate(ctx, code) {
  const { cfg, repo } = ctx
  const first = (await repo.userCount()) === 0
  if (!cfg.INVITE_ONLY) return { first, invite: null }
  // A short setup code would be guessable before the owner signs up: one under 12 is ignored.
  if (first) return cfg.SETUP_CODE.length >= 12 && sameString(code, cfg.SETUP_CODE) ? { first, invite: null } : null
  const invite = await repo.invite(code)
  return invite && !invite.usedBy && !invite.revoked ? { first, invite } : null
}
export const INVITE_REQUIRED = { error: 'a valid invite code is required', code: 'invite' }
export const INVITE_GONE = { error: 'invite code is no longer valid, ask for a new one', code: 'invite' }

// The new profile record: the first profile is made the owner, an invite is recorded.
export function newUser(gate, fields) {
  const user = { created: new Date().toISOString(), ...fields }
  if (gate.first) { user.admin = true; user.owner = true }
  if (gate.invite) user.invitedBy = gate.invite.code
  return user
}

// Stores a new profile only if its way in is still good, decided by the database itself so two
// sign-ups at once cannot both use one invite, or both become the first profile (the owner).
// Resolves to true when stored.
export async function claimAndCreate(ctx, gate, user) {
  const { db, repo } = ctx
  if (gate.invite) {
    const claimed = await db.prepare(`UPDATE invites SET data = json_set(data, '$.usedBy', ?, '$.usedAt', ?)
      WHERE code = ? AND json_extract(data, '$.usedBy') IS NULL AND json_extract(data, '$.revoked') IS NULL`)
      .bind(user.id, user.created, gate.invite.code).run()
    if (claimed.meta.changes !== 1) return false
    await repo.saveUser(user)
    return true
  }
  if (gate.first) {
    const made = await db.prepare('INSERT INTO users (id, data, created) SELECT ?, ?, ? WHERE NOT EXISTS (SELECT 1 FROM users)')
      .bind(user.id, JSON.stringify(user), user.created).run()
    return made.meta.changes === 1
  }
  await repo.saveUser(user)
  return true
}

/* ---------- names, e-mail and password sign-in ---------- */
const holdsName = u => hasPassword(u)
export function nameTaken(users, name, exceptId) {
  const k = nameKey(name)
  return users.some(u => u.id !== exceptId && ((holdsName(u) && nameKey(u.name) === k) || u.email === k))
}
export function emailTaken(users, e, exceptId) {
  return users.some(u => u.id !== exceptId && (u.email === e || (holdsName(u) && nameKey(u.name) === e)))
}
// Who a sign-in names: an identifier with "@" is looked up as an e-mail first, then as a name.
export function loginTarget(users, body) {
  const onlyEmail = body.identifier === undefined && body.name === undefined
  const k = nameKey(text(body.identifier ?? body.name ?? body.email).slice(0, 300))
  if (!k) return null
  const byEmail = k.includes('@') ? users.find(u => hasPassword(u) && u.email === k) : null
  const byName = onlyEmail ? null : users.find(u => hasPassword(u) && nameKey(u.name) === k)
  const user = byEmail || byName || null
  return { k, user, email: k.includes('@'), key: user ? 'acct:' + user.id : 'id:' + k }
}

export const addrKey = (ctx, kind) => kind + ':' + limitAddress(ctx.request.headers.get('cf-connecting-ip') || 'local')
export const tooMany = wait => json(429, { error: 'too many tries, wait a moment and try again', code: 'throttled', retryAfter: wait }, { headers: { 'Retry-After': String(wait) } })

// One password check against account key `k`. The attempt is counted on the account and the
// address before the hash runs; a right password gives it back. Resolves to { ok } or { res }.
export async function checkPassword(ctx, k, pw, stored) {
  const addr = addrKey(ctx, 'ip')
  const wait = await throttleAttempt(ctx.repo, [[k, LIMITS.account], [addr, LIMITS.address]])
  if (wait) return { res: tooMany(wait) }
  const ok = await verifyPassword(pw, stored)
  if (ok) { await ctx.repo.throttleClear(k); await ctx.repo.throttleUndo(addr) }
  return { ok }
}

// A wrong sign-up or setup code counts against the address; refused while paused.
export async function signupPaused(ctx) {
  const row = await ctx.repo.throttleRow(addrKey(ctx, 'signup'))
  return row && row.until > Date.now() ? Math.ceil((row.until - Date.now()) / 1000) : 0
}
export async function signupRejected(ctx) {
  const wait = await throttleAttempt(ctx.repo, [[addrKey(ctx, 'signup'), LIMITS.signup]])
  return wait ? tooMany(wait) : json(403, INVITE_REQUIRED)
}

/* ---------- proof that the signed-in owner is here ---------- */
// A passkey assertion made for this request, signed by one of this profile's passkeys.
export async function passkeyStepUp(ctx, user, body) {
  const { cfg, repo } = ctx
  const c = await repo.takeChallenge(text(body.cid))
  const cred = c?.kind === 'login' ? await repo.cred(body.credential?.id) : null
  if (!cred || cred.userId !== user.id) return false
  try {
    const v = await verifyAuthenticationResponse({
      response: body.credential, expectedChallenge: c.challenge, expectedOrigin: cfg.ORIGIN, expectedRPID: cfg.RP_ID,
      requireUserVerification: false,
      credential: { id: cred.id, publicKey: fromB64u(cred.publicKey), counter: cred.counter, transports: cred.transports }
    })
    if (!v.verified) return false
    cred.counter = v.authenticationInfo.newCounter
    cred.lastUsed = new Date().toISOString()
    await repo.saveCred(cred)
    return true
  } catch { return false }
}

// The proof api/server.js asks before adding or removing a way in (or pairing a phone): a passkey
// assertion, or the current password while password sign-in is on. Resolves to { proof } or { res }.
export async function proveOwner(ctx, user, body) {
  if (body.credential) {
    if (await passkeyStepUp(ctx, user, body)) return { proof: 'passkey' }
    return { res: json(403, { error: 'the passkey could not be verified', code: 'passkey' }) }
  }
  if (!passwordWayIn(ctx.cfg, user)) return { res: json(403, { error: 'confirm with your passkey first', code: 'passkey-required' }) }
  const current = typeof body.current === 'string' ? body.current : ''
  if (!current) return { res: json(403, { error: 'enter your current password', code: 'current-required' }) }
  const r = await checkPassword(ctx, 'acct:' + user.id, current, user.pw.h)
  if (r.res) return r
  if (!r.ok) return { res: json(403, { error: 'your current password is not right', code: 'current-wrong' }) }
  return { proof: 'password' }
}

// Re-reads the session after awaits: "sign out everywhere" may have ended it meanwhile.
export async function stillSignedIn(ctx, user) {
  ctx._session = undefined
  const s = await sessionOf(ctx)
  return !!s && s.user.id === user.id && (s.user.sv || 0) === (user.sv || 0)
}
