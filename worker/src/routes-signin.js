// Signing up, signing in and out, the phone pairing, and the public config.
import { generateRegistrationOptions, verifyRegistrationResponse, generateAuthenticationOptions, verifyAuthenticationResponse } from '@simplewebauthn/server'
import { transportsOf } from '../../api/passkeys-store.js'
import { json, readBody, text, b64u, fromB64u, randomId } from './http.js'
import { sessionOf, readSession, makeSession, sessionCookie, clearCookie, sessionVersion } from './session.js'
import { hashPassword, needsRehash, passwordProblem, normalizeEmail } from './password.js'
import {
  publicUser, hasPassword, notSignedIn, WRONG, verifyAnswer, signupGate, newUser, INVITE_REQUIRED, INVITE_GONE,
  nameTaken, emailTaken, loginTarget, checkPassword, proveOwner, stillSignedIn
} from './auth.js'

const enc = new TextEncoder()
const POLICY_ERRORS = {
  'too-short': 'the password needs at least 10 characters',
  'too-long': 'the password can have at most 256 characters',
  'too-common': 'this password is too easy to guess'
}
export const policyError = problem => json(400, { error: POLICY_ERRORS[problem], code: problem })

export const signinRoutes = {
  'GET /api/health': async ({ repo }) => json(200, { ok: true, users: await repo.userCount(), writable: true }),

  'GET /api/config': async ctx => {
    const { cfg } = ctx
    const signedIn = !!(await readSession(ctx))
    return json(200, {
      invite_only: cfg.INVITE_ONLY, allow_guest: cfg.ALLOW_GUEST,
      ...(cfg.PASSWORD_LOGIN ? { password_login: true } : {}),
      ...(cfg.DEFAULT_LANG ? { default_lang: cfg.DEFAULT_LANG } : {}),
      // No Coach on this server: the key is there (null) for a session, which is how the app
      // tells "no Coach here" from "asked before signing in".
      ...(signedIn ? { coach: null } : {})
    })
  },

  // A paired phone's token is renewed once past half its life.
  'GET /api/me': async ctx => {
    const s = await sessionOf(ctx)
    if (!s) return notSignedIn()
    const renew = s.bearer && s.kind !== 'c' && s.exp - Date.now() < ctx.cfg.SESSION_DAYS * 86400000 / 2
    return json(200, { user: publicUser(s.user), ...(renew ? { token: await makeSession(ctx.cfg, s.user) } : {}) })
  },

  /* ---------- passkeys ---------- */
  'POST /api/register/options': async ctx => {
    const { cfg, repo } = ctx
    const body = await readBody(ctx.request)
    const name = text(body.name).trim().slice(0, 40)
    if (!name) return json(400, { error: 'name required' })
    const code = text(body.code).trim().toUpperCase()
    if (!(await signupGate(ctx, code))) return json(403, INVITE_REQUIRED)
    const uid = randomId(12)
    const options = await generateRegistrationOptions({
      rpName: cfg.RP_NAME, rpID: cfg.RP_ID,
      userID: enc.encode(uid), userName: name, userDisplayName: name,
      attestationType: 'none',
      authenticatorSelection: { residentKey: 'required', userVerification: 'preferred' },
      excludeCredentials: []
    })
    const cid = await repo.putChallenge({ kind: 'register', challenge: options.challenge, name, uid, code })
    return json(200, { cid, options })
  },

  'POST /api/register/verify': async ctx => {
    const { cfg, repo, db } = ctx
    const body = await readBody(ctx.request)
    const c = await repo.takeChallenge(text(body.cid))
    if (!c || c.kind !== 'register' || !c.uid) return json(400, { error: 'challenge expired, try again', code: 'challenge-expired' })
    let verification
    try {
      verification = await verifyRegistrationResponse({
        response: body.credential, expectedChallenge: c.challenge, expectedOrigin: cfg.ORIGIN, expectedRPID: cfg.RP_ID,
        requireUserVerification: false
      })
    } catch (e) { return json(400, verifyAnswer(cfg, e)) }
    if (!verification.verified) return json(400, { error: 'not verified' })
    const { credential } = verification.registrationInfo
    if (await repo.cred(credential.id)) return json(409, { error: 'credential already registered' })
    // Checked again at the last moment: the invite may have been used or revoked since.
    const gate = await signupGate(ctx, c.code)
    if (!gate) return json(403, INVITE_GONE)
    const { user, invite } = newUser(gate, { id: c.uid, name: c.name })
    await db.batch([
      repo.saveUserStmt(user),
      repo.saveCredStmt({
        id: credential.id, userId: user.id, publicKey: b64u(credential.publicKey), counter: credential.counter || 0,
        transports: transportsOf(body.credential?.response?.transports), created: user.created, lastUsed: user.created
      }),
      ...(invite ? [repo.saveInviteStmt(invite)] : [])
    ])
    return json(200, { user: publicUser(user) }, { cookies: await sessionCookie(cfg, user) })
  },

  'POST /api/login/options': async ({ cfg, repo }) => {
    const options = await generateAuthenticationOptions({ rpID: cfg.RP_ID, userVerification: 'preferred', allowCredentials: [] })
    const cid = await repo.putChallenge({ kind: 'login', challenge: options.challenge })
    return json(200, { cid, options })
  },

  'POST /api/login/verify': async ctx => {
    const { cfg, repo } = ctx
    const body = await readBody(ctx.request)
    const c = await repo.takeChallenge(text(body.cid))
    if (c?.kind !== 'login') return json(400, { error: 'challenge expired, try again', code: 'challenge-expired' })
    const cred = await repo.cred(body.credential?.id)
    if (!cred) return json(404, { error: 'unknown passkey, create a profile first', code: 'unknown-credential' })
    let verification
    try {
      verification = await verifyAuthenticationResponse({
        response: body.credential, expectedChallenge: c.challenge, expectedOrigin: cfg.ORIGIN, expectedRPID: cfg.RP_ID,
        requireUserVerification: false,
        credential: { id: cred.id, publicKey: fromB64u(cred.publicKey), counter: cred.counter, transports: cred.transports }
      })
    } catch (e) { return json(400, verifyAnswer(cfg, e)) }
    if (!verification.verified) return json(400, { error: 'not verified' })
    cred.counter = verification.authenticationInfo.newCounter
    cred.lastUsed = new Date().toISOString()
    await repo.saveCred(cred)
    const user = await repo.user(cred.userId)
    if (!user) return json(500, { error: 'user missing' })
    if (user.disabled) return json(403, { error: 'this account has been disabled', code: 'disabled' })
    return json(200, { user: publicUser(user) }, { cookies: await sessionCookie(cfg, user) })
  },

  /* ---------- sign out ---------- */
  'POST /api/logout': async ({ cfg }) => json(200, { ok: true }, { cookies: clearCookie(cfg) }),

  // Bumps the session version: every cookie and phone token of the account stops working.
  'POST /api/logout/all': async ctx => {
    const user = await readSession(ctx)
    if (!user) return notSignedIn()
    user.sv = sessionVersion(user) + 1
    await ctx.repo.saveUser(user)
    await ctx.repo.dropPairings(user.id)
    return json(200, { ok: true }, { cookies: clearCookie(ctx.cfg) })
  },

  /* ---------- the phone app ---------- */
  // From a signed-in browser: a 5-minute, one-shot code the phone redeems for a token.
  'POST /api/pair/create': async ctx => {
    const user = await readSession(ctx)
    if (!user) return notSignedIn()
    const body = await readBody(ctx.request)
    const p = await proveOwner(ctx, user, body)
    if (p.res) return p.res
    if (!(await stillSignedIn(ctx, user))) return notSignedIn()
    return json(200, { code: await ctx.repo.putPairing(user.id) })
  },

  'POST /api/pair/redeem': async ctx => {
    const body = await readBody(ctx.request)
    const uid = await ctx.repo.takePairing(text(body.code).trim().toUpperCase())
    const user = uid && await ctx.repo.user(uid)
    if (!user || user.disabled) return json(400, { error: 'invalid or expired code', code: 'pair-invalid' })
    return json(200, { token: await makeSession(ctx.cfg, user), user: publicUser(user) })
  }
}

/* ---------- name and password (only while PASSWORD_LOGIN is on) ---------- */
export const passwordSigninRoutes = {
  'POST /api/login/password': async ctx => {
    const { cfg, repo } = ctx
    const body = await readBody(ctx.request)
    const users = await repo.users()
    const target = loginTarget(users, body)
    const pw = typeof body.password === 'string' ? body.password : ''
    if (!target || !pw) return json(400, { error: 'name and password required', code: 'missing' })
    const { user } = target
    const r = await checkPassword(ctx, target.key, pw, user?.pw?.h)
    if (r.res) return r.res
    if (!r.ok || !user) return json(401, WRONG)
    if (user.disabled) return json(403, { error: 'this account has been disabled', code: 'disabled' })
    if (needsRehash(user.pw.h, cfg.PBKDF2_ITER)) { user.pw.h = await hashPassword(pw, cfg.PBKDF2_ITER); await repo.saveUser(user) }
    return json(200, { user: publicUser(user) }, { cookies: await sessionCookie(cfg, user) })
  },

  'POST /api/register/password': async ctx => {
    const { cfg, repo, db } = ctx
    const body = await readBody(ctx.request)
    const name = text(body.name).trim().slice(0, 40)
    if (!name) return json(400, { error: 'name required', code: 'missing' })
    const code = text(body.code).trim().toUpperCase()
    if (!(await signupGate(ctx, code))) return json(403, INVITE_REQUIRED)
    const problem = passwordProblem(body.password, name)
    if (problem) return policyError(problem)
    const taken = () => json(409, { error: 'another profile already signs in with this name', code: 'name-taken' })
    const hasEmail = typeof body.email === 'string' && body.email.trim() !== ''
    const email = hasEmail ? normalizeEmail(body.email) : null
    if (hasEmail && !email) return json(400, { error: 'that is not an e-mail address', code: 'email-invalid' })
    const h = await hashPassword(body.password, cfg.PBKDF2_ITER)
    const gate = await signupGate(ctx, code)
    if (!gate) return json(403, INVITE_GONE)
    const users = await repo.users()
    if (nameTaken(users, name)) return taken()
    if (email && emailTaken(users, email)) return json(409, { error: 'another profile already uses this e-mail address', code: 'email-taken' })
    const { user, invite } = newUser(gate, { id: randomId(12), name, ...(email ? { email } : {}) })
    user.pw = { h, set: user.created }
    await db.batch([repo.saveUserStmt(user), ...(invite ? [repo.saveInviteStmt(invite)] : [])])
    return json(200, { user: publicUser(user) }, { cookies: await sessionCookie(cfg, user) })
  }
}
