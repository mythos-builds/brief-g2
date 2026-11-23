// Tokens, hashes, pairing codes and the refresh-token encryption. Web Crypto only.

const enc = new TextEncoder()

export function base64url(bytes: Uint8Array): string {
  let bin = ''
  for (const b of bytes) bin += String.fromCharCode(b)
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

export function base64(bytes: Uint8Array): string {
  let bin = ''
  for (const b of bytes) bin += String.fromCharCode(b)
  return btoa(bin)
}

export function fromBase64(s: string): Uint8Array {
  const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/'))
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

/** 32 random bytes, base64url: 43 characters (contract § 3.8). */
export function newToken(): string {
  return base64url(crypto.getRandomValues(new Uint8Array(32)))
}

export const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/

export async function sha256hex(s: string): Promise<string> {
  const d = new Uint8Array(await crypto.subtle.digest('SHA-256', enc.encode(s)))
  return Array.from(d, (b) => b.toString(16).padStart(2, '0')).join('')
}

/** A uniform 6-digit code (rejection sampling: 4,294,000,000 is a multiple of 1,000,000). */
export function newPairCode(): string {
  for (;;) {
    const n = crypto.getRandomValues(new Uint32Array(1))[0]!
    if (n < 4_294_000_000) return String(n % 1_000_000).padStart(6, '0')
  }
}

/** A per-response nonce for the CSP of our HTML pages. */
export function newNonce(): string {
  return base64url(crypto.getRandomValues(new Uint8Array(16)))
}

/** The AES-256-GCM key from the secret TOKEN_KEY (base64 of exactly 32 bytes). Throws without saying the value. */
export async function tokenKey(secret: string): Promise<CryptoKey> {
  let raw: Uint8Array
  try {
    raw = fromBase64(secret.trim())
  } catch {
    throw new Error('TOKEN_KEY is not base64')
  }
  if (raw.byteLength !== 32) throw new Error('TOKEN_KEY must be 32 bytes')
  return crypto.subtle.importKey('raw', raw, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt'])
}

export interface Sealed {
  iv: string // base64, 12 bytes, fresh per record
  ct: string // base64, ciphertext + 16-byte tag
}

/** Encrypts with a fresh 12-byte IV; `aad` binds the record to its row (the account's e-mail hash). */
export async function seal(key: CryptoKey, plaintext: string, aad: string): Promise<Sealed> {
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const ct = new Uint8Array(
    await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: enc.encode(aad) }, key, enc.encode(plaintext)),
  )
  return { iv: base64(iv), ct: base64(ct) }
}

export async function open(key: CryptoKey, sealed: Sealed, aad: string): Promise<string> {
  const pt = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: fromBase64(sealed.iv), additionalData: enc.encode(aad) },
    key,
    fromBase64(sealed.ct),
  )
  return new TextDecoder().decode(pt)
}
