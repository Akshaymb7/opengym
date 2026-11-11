// Settings → Account: passkeys, the password, the sign-in e-mail, deleting the profile.
import { generateRegistrationOptions, verifyRegistrationResponse } from '@simplewebauthn/server'
import { listPasskeys, addPasskeyRecord, renamePasskeyRecord, passkeyRemovalRefused, removePasskeyRecord, MAX_PASSKEYS } from '../../api/passkeys-store.js'
import { json, readBody, text, b64u } from './http.js'
import { sessionOf, readSession, makeSession, sessionCookie, clearCookie, sessionVersion } from './session.js'
import { hashPassword, passwordProblem, normalizeEmail } from './password.js'
import {
  hasPassword, passwordWayIn, notSignedIn, verifyAnswer, isAdmin, nameTaken, emailTaken, proveOwner, stillSignedIn, addrKey, tooMany
} from './auth.js'
import { throttleAttempt, LIMITS } from './repo.js'
import { policyError } from './routes-signin.js'

const enc = new TextEncoder()
const LIMIT = { error: `a profile can have at most ${MAX_PASSKEYS} passkeys`, code: 'passkey-limit' }

const passkeyState = (cfg, u, creds) => {
  const passkeys = listPasskeys({ creds }, u.id)
  const pw = passwordWayIn(cfg, u)
  return { passkeys, password: pw, lastWayIn: passkeys.length + (pw ? 1 : 0) <= 1 }
}
const EMAIL_INVALID = { error: 'that is not an e-mail address', code: 'email-invalid' }
const EMAIL_TAKEN = { error: 'another profile already uses this e-mail address', code: 'email-taken' }

// Seconds left on the longest pause among `keys`, without counting an attempt.
async function pausedFor(repo, keys) {
  let wait = 0
  for (const [key] of keys) {
    const row = await repo.throttleRow(key)
    if (row && row.until > Date.now()) wait = Math.max(wait, row.until - Date.now())
  }
  return Math.ceil(wait / 1000)
}

async function removeEmail(ctx, user, body) {
  if (!user.email) return json(200, { ok: true, email: null })
  const p = await proveOwner(ctx, user, body)
  if (p.res) return p.res
  if (!(await stillSignedIn(ctx, user))) return notSignedIn()
  delete user.email
  await ctx.repo.saveUser(user)
  return json(200, { ok: true, email: null })
}

async function lastAdminLeaving(repo, u) {
  if (!isAdmin(u)) return false
  const users = await repo.users()
  return users.length > 1 && users.filter(isAdmin).length <= 1
}

export const accountRoutes = {
  'GET /api/account/passkeys': async ctx => {
    const user = await readSession(ctx)
    if (!user) return notSignedIn()
    const creds = await ctx.repo.credsOf(user.id)
    return json(200, { ...passkeyState(ctx.cfg, user, creds), ...((await lastAdminLeaving(ctx.repo, user)) ? { deleteBlocked: 'last-admin' } : {}) })
  },

  // Adding one, step one: the proof, then creation options that exclude the ones it has.
  'POST /api/account/passkeys/options': async ctx => {
    const { cfg, repo } = ctx
    const user = await readSession(ctx)
    if (!user) return notSignedIn()
    const body = await readBody(ctx.request)
    const creds = await repo.credsOf(user.id)
    if (creds.length >= MAX_PASSKEYS) return json(409, LIMIT)
    const p = await proveOwner(ctx, user, body)
    if (p.res) return p.res
    if (!(await stillSignedIn(ctx, user))) return notSignedIn()
    const options = await generateRegistrationOptions({
      rpName: cfg.RP_NAME, rpID: cfg.RP_ID,
      userID: enc.encode(user.id), userName: user.name, userDisplayName: user.name,
      attestationType: 'none',
      authenticatorSelection: { residentKey: 'required', userVerification: 'preferred' },
      excludeCredentials: creds.map(c => ({ id: c.id, transports: c.transports || [] }))
    })
    const cid = await repo.putChallenge({ kind: 'add', challenge: options.challenge, uid: user.id, sv: sessionVersion(user), proof: p.proof })
    return json(200, { cid, options })
  },

  'POST /api/account/passkeys/verify': async ctx => {
    const { cfg, repo } = ctx
    const user = await readSession(ctx)
    if (!user) return notSignedIn()
    const body = await readBody(ctx.request)
    const c = await repo.takeChallenge(text(body.cid))
    if (!c || c.kind !== 'add' || c.uid !== user.id) return json(400, { error: 'challenge expired, try again', code: 'challenge-expired' })
    let verification
    try {
      verification = await verifyRegistrationResponse({
        response: body.credential, expectedChallenge: c.challenge, expectedOrigin: cfg.ORIGIN, expectedRPID: cfg.RP_ID,
        requireUserVerification: false
      })
    } catch (e) { return json(400, verifyAnswer(cfg, e)) }
    if (!verification.verified) return json(400, { error: 'not verified' })
    if (sessionVersion(user) !== c.sv) return notSignedIn()
    const { credential } = verification.registrationInfo
    if (await repo.cred(credential.id)) return json(409, { error: 'credential already registered', code: 'credential-exists' })
    const creds = await repo.credsOf(user.id)
    const added = addPasskeyRecord({ creds }, user.id, {
      id: credential.id, publicKey: b64u(credential.publicKey), counter: credential.counter || 0,
      transports: body.credential?.response?.transports, name: body.name
    })
    if (added.error) return json(409, { error: added.error, code: added.code })
    await repo.saveCred(added.row)
    return json(200, { ok: true, ...passkeyState(cfg, user, creds) })
  },

  'POST /api/account/passkeys/rename': async ctx => {
    const user = await readSession(ctx)
    if (!user) return notSignedIn()
    const body = await readBody(ctx.request)
    const creds = await ctx.repo.credsOf(user.id)
    const r = renamePasskeyRecord({ creds }, user.id, text(body.id), body.name)
    if (r.error) return json(404, { error: r.error, code: r.code })
    await ctx.repo.saveCred(r.row)
    return json(200, { ok: true, ...passkeyState(ctx.cfg, user, creds) })
  },

  // `?id=` the credential; the body carries the proof. The last way in is never removed.
  'DELETE /api/account/passkeys': async ctx => {
    const { cfg, repo } = ctx
    const user = await readSession(ctx)
    if (!user) return notSignedIn()
    const id = ctx.url.searchParams.get('id') || ''
    const body = await readBody(ctx.request)
    const refuse = r => json(r.code === 'last-way-in' ? 409 : 404, { error: r.error, code: r.code })
    const others = passwordWayIn(cfg, user) ? 1 : 0
    let creds = await repo.credsOf(user.id)
    const refused = passkeyRemovalRefused({ creds }, user.id, id, others)
    if (refused) return refuse(refused)
    const p = await proveOwner(ctx, user, body)
    if (p.res) return p.res
    if (!(await stillSignedIn(ctx, user))) return notSignedIn()
    creds = await repo.credsOf(user.id)
    const r = removePasskeyRecord({ creds }, user.id, id, others)
    if (r.error) return refuse(r)
    await repo.deleteCred(id)
    return json(200, { ok: true, ...passkeyState(cfg, user, creds) })
  },

  // Typed name to confirm, plus the owner's proof — except for a paired phone on a profile with no
  // password, where the pairing is the proof (the phone has no passkey for this server).
  'POST /api/account/delete': async ctx => {
    const { cfg, repo } = ctx
    const s = await sessionOf(ctx)
    if (!s) return notSignedIn()
    const { user } = s
    const body = await readBody(ctx.request)
    if (typeof body.name !== 'string' || body.name.trim() !== user.name) return json(400, { error: 'type the account name to confirm', code: 'confirm-name' })
    const refuseLastAdmin = () => json(409, { error: 'the last admin cannot leave while other profiles remain', code: 'last-admin' })
    if (await lastAdminLeaving(repo, user)) return refuseLastAdmin()
    const paired = s.bearer && s.kind !== 'c'
    if (!(paired && !passwordWayIn(cfg, user))) {
      const p = await proveOwner(ctx, user, body)
      if (p.res) return p.res
    }
    if (!(await stillSignedIn(ctx, user))) return notSignedIn()
    if (await lastAdminLeaving(repo, user)) return refuseLastAdmin()
    await repo.deleteUser(user.id)
    return json(200, { ok: true }, { cookies: clearCookie(cfg) })
  }
}

export const passwordAccountRoutes = {
  'GET /api/account/password': async ctx => {
    const user = await readSession(ctx)
    if (!user) return notSignedIn()
    const users = await ctx.repo.users()
    return json(200, {
      set: hasPassword(user), setAt: user.pw?.set || null, passkeys: await ctx.repo.credCount(user.id),
      name: user.name, nameTaken: nameTaken(users, user.name, user.id), email: user.email || null
    })
  },

  // Set or change. A new password ends every other session (version bump), like api/server.js.
  'POST /api/account/password': async ctx => {
    const { cfg, repo } = ctx
    const s = await sessionOf(ctx)
    if (!s) return notSignedIn()
    const { user } = s
    const body = await readBody(ctx.request)
    const problem = passwordProblem(body.next, user.name)
    if (problem) return policyError(problem)
    const taken = () => json(409, { error: 'another profile already signs in with this name', code: 'name-taken' })
    if (nameTaken(await repo.users(), user.name, user.id)) return taken()
    // A profile with no password yet proves itself with a passkey (proveOwner says so).
    const p = await proveOwner(ctx, user, body)
    if (p.res) return p.res
    const h = await hashPassword(body.next, cfg.PBKDF2_ITER)
    if (!(await stillSignedIn(ctx, user))) return notSignedIn()
    user.pw = { h, set: new Date().toISOString() }
    user.sv = sessionVersion(user) + 1
    await repo.saveUser(user)
    await repo.dropPairings(user.id)
    await repo.throttleClear('acct:' + user.id)
    if (s.bearer) return json(200, { ok: true, token: await makeSession(cfg, user) })
    return json(200, { ok: true }, { cookies: await sessionCookie(cfg, user) })
  },

  // Set or change the address this profile may sign in with; `email` empty or null removes it.
  // The same proof as a password (proveOwner). An address already in use is refused only after
  // the proof and counts against the caller's account and address, as in api/server.js.
  'POST /api/account/email': async ctx => {
    const { repo } = ctx
    const s = await sessionOf(ctx)
    if (!s) return notSignedIn()
    const { user } = s
    const body = await readBody(ctx.request)
    if (body.email == null || (typeof body.email === 'string' && body.email.trim() === '')) return removeEmail(ctx, user, body)
    const email = normalizeEmail(body.email)
    if (!email) return json(400, EMAIL_INVALID)
    if (email === user.email) return json(200, { ok: true, email })
    const keys = [['email:acct:' + user.id, LIMITS.address], [addrKey(ctx, 'email'), LIMITS.address]]
    let wait = await pausedFor(repo, keys)
    if (wait) return tooMany(wait)
    const p = await proveOwner(ctx, user, body)
    if (p.res) return p.res
    if (!(await stillSignedIn(ctx, user))) return notSignedIn()
    if (emailTaken(await repo.users(), email, user.id)) {
      wait = await throttleAttempt(repo, keys)
      return wait ? tooMany(wait) : json(409, EMAIL_TAKEN)
    }
    user.email = email
    await repo.saveUser(user)
    return json(200, { ok: true, email })
  },

  'DELETE /api/account/email': async ctx => {
    const user = await readSession(ctx)
    if (!user) return notSignedIn()
    return removeEmail(ctx, user, await readBody(ctx.request))
  },

  'DELETE /api/account/password': async ctx => {
    const { repo } = ctx
    const user = await readSession(ctx)
    if (!user) return notSignedIn()
    const body = await readBody(ctx.request)
    const lastWayIn = () => json(409, { error: 'the password is the only way into this profile', code: 'last-way-in' })
    if (!hasPassword(user)) return json(200, { ok: true })
    if (!(await repo.credCount(user.id))) return lastWayIn()
    const p = await proveOwner(ctx, user, body)
    if (p.res) return p.res
    if (!(await stillSignedIn(ctx, user))) return notSignedIn()
    if (!(await repo.credCount(user.id))) return lastWayIn()
    delete user.pw
    await repo.saveUser(user)
    return json(200, { ok: true })
  }
}
