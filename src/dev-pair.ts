// DEV-PAIR-ONLY (BRIEF-D4.md § 3.12): pairing for the simulator, which cannot type in the phone-side page.
// main.ts imports this module only under `if (import.meta.env.DEV)`, so no production build holds it (a test builds
// both and searches dist/ for the marker above). It claims the code through the normal `/api/pair/claim` (the
// client's own `claim`, which stores the session exactly as a typed code), then removes `pair` from the address.

export const DEV_PAIR_MARKER = 'DEV-PAIR-ONLY'

/** `?pair=<6 digits>` → the code; anything else → undefined. */
export function pairCodeOf(search: string): string | undefined {
  const v = new URLSearchParams(search).get('pair')
  return v !== null && /^\d{6}$/.test(v) ? v : undefined
}

/** The address without its `pair` parameter (the other parameters and the hash are kept). */
export function withoutPair(href: string): string {
  const u = new URL(href)
  u.searchParams.delete('pair')
  return u.toString()
}

export interface DevPairDeps {
  href: string
  claim(code: string): Promise<void>
  replace(href: string): void // history.replaceState
}

/** Returns what happened (for the phone-side status line); the parameter is removed whether the claim worked or not. */
export async function devPair(d: DevPairDeps): Promise<'none' | 'paired' | 'failed'> {
  const u = new URL(d.href)
  if (!u.searchParams.has('pair')) return 'none'
  const code = pairCodeOf(u.search)
  // the marker is USED (not only a comment), so any build that holds this code also holds the marker
  console.log(`${DEV_PAIR_MARKER}: pairing from the address`)
  d.replace(withoutPair(d.href))
  if (!code) return 'failed'
  try {
    await d.claim(code)
    return 'paired'
  } catch {
    return 'failed'
  }
}
