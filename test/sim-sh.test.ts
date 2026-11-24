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

// D5, job S: the simulator's microphone. `SIM_MIC=1 sim.sh start` picks the :mic image and `--aid alsa:pulse`; anything else
// is the day-4 command exactly. `sim.sh speak <file>` hands the file's BYTES to the container on stdin: its name is never an
// argument and never shell text, so a quote or a space in it runs nothing.
function podmanStub(bin: string, argsFile: string, stdinFile: string): void {
  stub(bin, 'podman', `if [ "$1" = run ] || [ "$1" = exec ]; then for a in "$@"; do printf '%s\\n' "$a"; done > '${argsFile}'; fi; [ "$1" = exec ] && cat > '${stdinFile}'; exit 0`)
}

function runStart(extraEnv: Record<string, string>): { args: string[]; script: string; image: string } {
  const dir = mkdtempSync(join(tmpdir(), 'sim-sh-mic-'))
  try {
    const bin = join(dir, 'bin')
    execFileSync('mkdir', [bin])
    const argsFile = join(dir, 'podman-args')
    podmanStub(bin, argsFile, join(dir, 'stdin'))
    stub(bin, 'curl', 'exit 0')
    execFileSync('sh', [SIM_SH, 'start', 'http://127.0.0.1:5174/'], { env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, SIM_VOLUME: '', ...extraEnv } })
    const args = readFileSync(argsFile, 'utf8').split('\n').slice(0, -1)
    const c = args.indexOf('-c')
    return { args, script: args[c + 1]!, image: args[c - 2]! }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

const HAS_BIN = { skip: !existsSync(SIM_BIN) && 'no simulator binary installed' }

test('sim.sh start: SIM_MIC=1 uses the mic image, the pulse device and a null sink; the address stays one argument', HAS_BIN, () => {
  const r = runStart({ SIM_MIC: '1' })
  assert.equal(r.image, 'localhost/er-sim:mic')
  assert.match(r.script, /--aid alsa:pulse/)
  assert.match(r.script, /module-null-sink sink_name=mic/)
  assert.match(r.script, /set-default-source mic\.monitor/)
  assert.ok(!r.script.includes('127.0.0.1'), 'the address is not inside the shell script')
  assert.deepEqual(r.args.slice(r.args.indexOf('-c') + 2), ['sh', '9898', 'http://127.0.0.1:5174/'])
})

test('sim.sh start: without exactly SIM_MIC=1 the command is the day-4 one (same image, no microphone)', HAS_BIN, () => {
  const envs: Record<string, string>[] = [{}, { SIM_MIC: '' }, { SIM_MIC: '0' }, { SIM_MIC: 'yes' }, { SIM_MIC: '11' }]
  for (const env of envs) {
    const r = runStart(env)
    assert.equal(r.image, 'localhost/er-sim:bookworm', JSON.stringify(env))
    assert.ok(!/--aid|pulse/.test(r.script), JSON.stringify(env))
    assert.match(r.script, /exec \/opt\/sim\/evenhub-simulator --automation-port "\$1" "\$2"'?$/)
  }
})

test('sim.sh speak: a file name with a quote and a space never reaches the container; its bytes do, on stdin', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sim-sh-speak-'))
  try {
    const bin = join(dir, 'bin')
    execFileSync('mkdir', [bin])
    const argsFile = join(dir, 'podman-args')
    const stdinFile = join(dir, 'stdin')
    podmanStub(bin, argsFile, stdinFile)
    const pwned = join(dir, 'pwned')
    const name = `a b'; touch pwned; echo '.wav` // no slash in it: the file lives in `dir`, where the script runs
    writeFileSync(join(dir, name), 'RIFF-not-really-a-wav')
    execFileSync('sh', [SIM_SH, 'speak', name], { cwd: dir, env: { ...process.env, PATH: `${bin}:${process.env.PATH}` } })
    const args = readFileSync(argsFile, 'utf8')
    assert.ok(!args.includes('touch') && !args.includes('RIFF'), 'no argument holds any part of the file name')
    assert.equal(readFileSync(stdinFile, 'utf8'), 'RIFF-not-really-a-wav')
    assert.match(args, /^exec\n-i\n/)
    assert.equal(existsSync(pwned), false, 'nothing in the file name ran')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('sim.sh speak: no file name, or a file that is not there, is refused before podman is called', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sim-sh-speak-'))
  try {
    const bin = join(dir, 'bin')
    execFileSync('mkdir', [bin])
    const called = join(dir, 'called')
    stub(bin, 'podman', `touch '${called}'`)
    for (const argv of [['speak'], ['speak', join(dir, 'missing.wav')]]) {
      assert.throws(() => execFileSync('sh', [SIM_SH, ...argv], { env: { ...process.env, PATH: `${bin}:${process.env.PATH}` }, stdio: 'pipe' }))
    }
    assert.equal(existsSync(called), false)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
