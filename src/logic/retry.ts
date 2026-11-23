// « No connection — retrying » retries by itself (BRIEF-D3.md § 4.1a, day-2 tester fail 42): after 2 s, 5 s, 15 s,
// then every 30 s. A press retries at once (main.ts: the F press reloads; `disarm` drops the pending timer first).
// The timer stops on success (`stop`) and while the app is in the background (`pause` / `resume`).
// Pure: the timer functions are passed in, so `npm test` drives it with a fake clock.

export const RETRY_DELAYS_MS = [2000, 5000, 15000, 30000] as const

/** The wait before retry number `done + 1`, `done` = the automatic retries already made. */
export function retryDelay(done: number): number {
  return RETRY_DELAYS_MS[Math.min(Math.max(done, 0), RETRY_DELAYS_MS.length - 1)]
}

export interface Timers {
  set(fn: () => void, ms: number): unknown
  clear(handle: unknown): void
}

export interface Retry {
  /** The screen is « No connection »: arm the next retry (no-op when one is already armed). */
  arm(): void
  /** A load is starting (a press, or the timer itself): drop the pending timer, keep the count. */
  disarm(): void
  /** The list loaded (or another screen replaced « No connection »): no timer, the count starts again. */
  stop(): void
  pause(): void
  resume(): void
  armed(): boolean
  /** The automatic retries made since the last `stop`. */
  done(): number
}

export function createRetry(timers: Timers, run: () => void): Retry {
  let handle: unknown
  let done = 0
  let wanted = false // a retry is owed (kept across a pause)
  let paused = false

  function clear(): void {
    if (handle !== undefined) timers.clear(handle)
    handle = undefined
  }

  function schedule(): void {
    if (handle !== undefined || paused || !wanted) return
    handle = timers.set(() => {
      handle = undefined
      wanted = false
      done++
      run()
    }, retryDelay(done))
  }

  return {
    arm() {
      wanted = true
      schedule()
    },
    disarm() {
      wanted = false
      clear()
    },
    stop() {
      wanted = false
      clear()
      done = 0
    },
    pause() {
      paused = true
      clear()
    },
    resume() {
      paused = false
      schedule()
    },
    armed: () => handle !== undefined,
    done: () => done,
  }
}
