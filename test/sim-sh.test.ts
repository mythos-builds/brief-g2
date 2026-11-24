// D4 review, NOTE 6: `tools/sim.sh start <url>` must hand the start address to the simulator as ONE argument, never as
// shell text: a `'` in the address must not end the quoting and run in the container's shell. podman, curl, Xvfb and
// sleep are stubbed on PATH (nothing starts, no container); the `sh -c` script podman would run is then run here with
// the simulator's path pointed at a stub that writes down the arguments it got.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const SIM_SH = join(import.meta.dirname, '..', 'tools', 'sim.sh')
const SIM_BIN = join(import.meta.dirname, '..', 'tools', 'node_modules', '@evenrealities', 'sim-linux-x64', 'bin', 'evenhub-simulator')

function stub(dir: string, name: string, body: string): void {
  const p = join(dir, name)
  writeFileSync(p, `#!/bin/sh\n${body}\n`)
  chmodSync(p, 0o755)
}

test('sim.sh start: an address holding a quote reaches the simulator as one argument and runs nothing', { skip: !existsSync(SIM_BIN) && 'no simulator binary installed' }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'sim-sh-'))
  try {
    const bin = join(dir, 'bin')
    execFileSync('mkdir', [bin])
    const argsFile = join(dir, 'podman-args')
    const pwned = join(dir, 'pwned')
    // podman: `rm` does nothing; `run` writes its arguments, one per line (no argument here holds a newline)
    stub(bin, 'podman', `[ "$1" = run ] && for a in "$@"; do printf '%s\\n' "$a"; done > '${argsFile}'; exit 0`)
    stub(bin, 'curl', 'exit 0')
    const url = `http://127.0.0.1:5174/?pair=123456&x='; touch ${pwned}; echo '`
    execFileSync('sh', [SIM_SH, 'start', url], { env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, SIM_VOLUME: '' } })
    const args = readFileSync(argsFile, 'utf8').split('\n').slice(0, -1)
    const c = args.indexOf('-c')
    assert.ok(c > 0, 'podman run … sh -c <script>')
    const script = args[c + 1]!
    assert.ok(!script.includes('pair=123456'), 'the address is not inside the shell script')

    // run that script as the container would, with Xvfb, sleep and the simulator stubbed
    const simArgs = join(dir, 'sim-args')
    stub(bin, 'Xvfb', 'exit 0')
    stub(bin, 'sleep', 'exit 0')
    stub(bin, 'fake-sim', `for a in "$@"; do printf '%s\\n' "$a"; done > '${simArgs}'`)
    execFileSync('sh', ['-c', script.replace('/opt/sim/evenhub-simulator', join(bin, 'fake-sim')), ...args.slice(c + 2)], {
      env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
    })
    assert.deepEqual(readFileSync(simArgs, 'utf8').split('\n').slice(0, -1), ['--automation-port', '9898', url])
    assert.equal(existsSync(pwned), false, 'nothing in the address ran')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
