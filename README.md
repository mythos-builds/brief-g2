# Brief

Brief is an app for Even Realities G2 smart glasses that shows the few messages that need you, with a reply ready.
Press once to see who is waiting (« 2 need you »); press a line to read a short summary and the drafted reply.
A reply goes out only after two deliberate presses on labelled items (`Send`, then `Send now`). Nothing is ever sent on its own.

Built with AI agents, said plainly: the code, tests and docs in this repository were written by AI agents
(Claude models) working from written briefs, and checked by another agent before each commit.

## What existed before Nov 23

- The simulator launcher `tools/sim.sh` and its container file `tools/sim-container/Containerfile` (dev tooling: they
  run the official Even Hub simulator in a container on our machine).
- The fictional demo dataset `demo/dataset.json` (every person, company and address in it is invented).
- The design notes (screens, gestures and plan, written as text before the build week).

Everything else is written from 2026-11-23 03:00 EST.

## Run it

```sh
npm install --ignore-scripts
npm run dev     # 127.0.0.1:5173
npm test        # pure logic: list building, counts, cursor moves, the two-press send rule
npm run build   # type check + Vite build into dist/
npm run shots   # walks every screen in the simulator, writes docs/screens/*.png, checks size and line widths
```

Day 1 runs on static demo data (`src/data/dataset.json`). The `SOURCES` switch (`src/config.ts`) is mail only by
default; with Telegram on, Telegram items join the same list with a « TG » tag.
