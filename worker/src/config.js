// The Worker's settings, read from wrangler.jsonc `vars` and secrets. Same names and meaning as the
// env vars of api/server.js (docs/SELF_HOSTING.md), so the app sees the same /api/config answers.
const on = v => /^(1|true|yes|on)$/i.test(String(v ?? ''))
const off = v => /^(0|false|no|off)$/i.test(String(v ?? ''))

export function configOf(env) {
  const ORIGIN = String(env.ORIGIN || 'http://localhost:8787').replace(/\/+$/, '')
  const lang = String(env.DEFAULT_LANG || '').trim()
  return {
    ORIGIN,
    RP_ID: env.RP_ID || new URL(ORIGIN).hostname,
    RP_NAME: env.RP_NAME || 'openGym',
    SECURE: ORIGIN.startsWith('https://'),
    INVITE_ONLY: on(env.INVITE_ONLY),
    PASSWORD_LOGIN: on(env.PASSWORD_LOGIN),
    ALLOW_GUEST: !off(env.ALLOW_GUEST),
    SESSION_DAYS: Math.max(1, +(env.SESSION_DAYS || 90) || 90),
    DEFAULT_LANG: /^[A-Za-z]{2,3}([-_][A-Za-z0-9]{2,8})?$/.test(lang) ? lang : '',
    // Signs cookies and phone tokens. Required: without it nothing can be signed in.
    SECRET: String(env.SESSION_SECRET || ''),
    // Lets the very first profile sign up on an invite-only instance, where nobody can make an
    // invite yet. Ignored once any profile exists.
    SETUP_CODE: String(env.SETUP_CODE || '').trim().toUpperCase(),
    // PBKDF2 rounds for new password hashes. 100,000 is the most Workers allow.
    PBKDF2_ITER: Math.min(100000, Math.max(10000, +(env.PBKDF2_ITER || 100000) || 100000))
  }
}
