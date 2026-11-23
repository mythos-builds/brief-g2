# Brief

Brief is an app for Even Realities G2 smart glasses that shows the few messages that need you, with a reply ready.
Press once to see who is waiting (« 2 need you »); press a line to read a short summary and the drafted reply.
A reply goes out only after two deliberate presses on labelled items (`Send`, then `Send now`). Nothing is ever sent on its own.

Built with AI agents, said plainly: the code, tests and docs in this repository were written by AI agents
(Claude models) working from written briefs, and checked by another agent before each commit.

## What existed before Nov 23

Brought into this repository on 2026-11-23 so a clone runs on its own; their content is unchanged except the paths:

- `tools/sim.sh`, `tools/sim-container/Containerfile`, `tools/package.json`, `tools/package-lock.json`: the simulator
  launcher (dev tooling written 2026-11-18). It runs the official Even Hub simulator in a podman container on our
  machine. Day 2 changes: the simulator binary is found next to the script (`tools/node_modules`, was a path in our home
  folder) and the two package versions are pinned exact (`@evenrealities/evenhub-cli` 0.2.0,
  `@evenrealities/evenhub-simulator` 0.9.5, were `^` ranges).
- `demo/dataset.json` and `demo/README.md`: the fictional demo dataset (written 2026-11-19; every person, company and
  address in it is invented). `src/data/dataset.json` is a byte-identical copy (a test checks it).
- The design notes (screens, gestures and plan, written as text before the build week; kept outside this repository).

Everything else is written from 2026-11-23 03:00 EST. `@evenrealities/even_hub_sdk` is the vendor's SDK; its published
`dist` is obfuscated by the vendor.

## Run it

Node 24 or newer.

```sh
npm install --ignore-scripts
npm run dev     # 127.0.0.1:5173
npm test        # pure logic: list building, the two-press send rule, reply checks, the backend client, PNG flattening
npm run build   # type check + Vite build into dist/ (relative asset paths: works under /app/ and in an Even Hub package)
npm run shots   # walks every screen in the simulator, writes docs/screens/*.png (RGB on black), checks size and line widths
(cd server && node --test triage/)   # the triage layer's tests
```

`npm run shots` needs podman, the image built once (`podman build -t localhost/er-sim:bookworm tools/sim-container`)
and the simulator packages (`cd tools && npm ci --ignore-scripts`).

## Data source

- `static` (default): the demo dataset in `src/data/`. Tests and `npm run shots` always run on it.
- `backend`: build with `VITE_DATA_SOURCE=backend`. The app asks the Brief Worker on the same origin
  (`https://brief.appfinishers.com/app/` → `/api/…`); `VITE_API_BASE=http://127.0.0.1:8787` points it at a local Worker.
  On start it opens a demo session (a stored paired session wins), loads the items, and shows the same screens.
  `Send now` posts only the index of the reply shown (0 = the draft, 1–4 = an alternative) and shows `Sent` only after the
  Worker answers 200; on day 2 the Worker sends nothing. A failure shows a plain line on the glasses, never an error code.
- Pairing: the phone-side page shows « Have a code? »; the 6-digit code from `brief.appfinishers.com/connect` gives a
  paired session, kept with the SDK's storage. `VITE_REQUIRE_PAIRING=1` makes the glasses show « Sign-in needed » until
  then (default off = demo mode).
- `SOURCES` (`src/config.ts`) is mail only by default; with Telegram on, Telegram items join the same list with a « TG » tag.
  The `?sources=`, `?at=` and `?states=1` URL switches work on the dev server only.

## Screens (`docs/screens/`)

`19-double-press-sim.png`: on a double-press the app calls the system exit dialog (`shutDownPageContainer(1)`). The
simulator (0.9.5) draws no dialog: the glasses canvas goes black. What the real glasses show is not checked yet.
