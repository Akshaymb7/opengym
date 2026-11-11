// Password hashing for Workers. api/password.js uses scrypt at N=2^15 (32 MiB, ~100 ms of CPU),
// which does not fit a Worker's CPU budget; PBKDF2-SHA256 runs natively in WebCrypto instead.
// The password *rules* (length, common passwords, name+digits) are api/password.js's own.
import { b64, fromB64, sameString } from './http.js'
export { passwordProblem, passwordLength, nameKey, normalizeEmail, MIN_LENGTH, MAX_LENGTH } from '../../api/password.js'
import { MAX_LENGTH, passwordLength } from '../../api/password.js'

const enc = new TextEncoder()
const normalize = pw => String(pw).normalize('NFKC')
const RE = /^\$pbkdf2-sha256\$i=(\d{4,6})\$([A-Za-z0-9+/]+=*)\$([A-Za-z0-9+/]+=*)$/

async function derive(pw, salt, iterations) {
  const key = await crypto.subtle.importKey('raw', enc.encode(normalize(pw)), 'PBKDF2', false, ['deriveBits'])
  return new Uint8Array(await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations }, key, 256))
}

export async function hashPassword(pw, iterations = 100000) {
  const salt = crypto.getRandomValues(new Uint8Array(16))
  return `$pbkdf2-sha256$i=${iterations}$${b64(salt)}$${b64(await derive(pw, salt, iterations))}`
}

// An unknown account or a malformed hash costs the same work as a real check, so the answer's
// timing does not say which names exist.
const DUMMY_SALT = new Uint8Array(16)
export async function verifyPassword(pw, stored) {
  if (typeof pw !== 'string' || passwordLength(pw) > MAX_LENGTH) return false
  const m = RE.exec(String(stored || ''))
  if (!m) { await derive(pw, DUMMY_SALT, 100000); return false }
  const got = await derive(pw, fromB64(m[2]), Number(m[1]))
  return sameString(b64(got), m[3])
}

export const needsRehash = (stored, iterations) => {
  const m = RE.exec(String(stored || ''))
  return !m || Number(m[1]) !== iterations
}
