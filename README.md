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
npm run shots   # walks every screen in the simulator, writes docs/screens/*.png (RGB on black), checks size and line widths;
                # the backend runs use a second dev server (127.0.0.1:5174) and the in-memory stub of test/stub-backend.ts (127.0.0.1:8788)
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
  Worker answers 200. Whether a real mail leaves is the Worker's decision (day 4: paired, `REAL_SEND` on); its answer
  `"real":false` adds the line `Demo: no real mail was sent` (`Demo: no real message was sent` for a Telegram item). `send_failed` keeps C with
  `Not sent. Send now to try again.` (the cursor is back on `Back`, so the line names the row)
  (`Send now` posts the same index again) · `send_unknown` → `Not confirmed. Check Sent on your phone.` (a press opens the
  next item) · `daily_cap` → `Daily send limit reached. Try tomorrow.` · `already_handled` → `Already handled.`, then the
  list is read again. A failure shows a plain line on the glasses, never an error code.
- Calendar (day 3): after the list, the app asks `GET /api/calendar`; its `now` is the clock in the header and its events
  give `next 14:00 Supplier call` and the meeting brief (E, due from 10 minutes before an event that has a brief until
  it starts). A failed calendar call never blocks the list: the header then shows the device's own clock (local `HH:MM`) and no `next`.
- `No connection — retrying` retries by itself after 2 s, 5 s, 15 s, then every 30 s; a press retries at once; the timer
  stops once the list loads and while the app is in the background (SDK events 5 / 6 / 7; it resumes on 4).
- A paired account whose Google grant is dead (403 `signin_needed`) shows « Sign-in needed » and two numbered steps with
  `<host>/connect` (the host from `src/config.ts`); the phone-side page shows the same steps, the address as plain text and
  a copy button. The paired session is kept. A paired session the server no longer knows (401) is forgotten, never silently swapped for
  demo data: the glasses show « Sign-in needed », the phone-side page says the session ended, and a press shows demo data.
- The phone-side page shows which data the glasses show (« Demo data » or « Your inbox »), the code form, and
  « Disconnect » while paired: `POST /api/session/logout` first (3 s at most, any failure ignored), then the session is
  forgotten in the SDK storage whatever the answer; the page says the session is closed; back to demo.
- Pairing: the phone-side page shows « Have a code? »; the 6-digit code from `brief.appfinishers.com/connect` gives a
  paired session, kept with the SDK's storage. `VITE_REQUIRE_PAIRING=1` makes the glasses show « Sign-in needed » until
  then (default off = demo mode).
- Dev pairing, for the simulator (it cannot type in the phone-side page): on the dev server only (`import.meta.env.DEV`),
  `?pair=<6 digits>` in the app's address is claimed through `/api/pair/claim` at start, stored like a typed code, then
  removed from the address (`src/dev-pair.ts`; `npm test` builds both production builds and finds it in no file of
  `dist/`). With the simulator: `tools/sim.sh start 'http://127.0.0.1:5174/?pair=123456'`. `sim.sh` keeps the simulator
  user's home on the podman volume `er-sim-data` (`SIM_VOLUME=` for none, `sim.sh wipe` removes it); see Known limits.
- « Speak a change » (day 5, backend mode, demo and paired; offered only when the items answer says `"voice": true`, so
  never in static mode): B's fourth row. After the pick the glasses draw `Listening… press to stop` with an 11-cell level
  bar, THEN turn on the glasses microphone (`audioControl(true, AudioInputSource.Glasses)`); it stops on a press, at 10 s of
  sound (320,000 bytes) or 12 s on the clock, and is turned off before anything else, on every way out (the stop, each
  error, the double-press, the background, an abnormal exit). What leaves the glasses: that clip only, raw samples (16 kHz,
  16-bit, mono, 10 s at most), posted once to the Brief server (`POST /api/items/<id>/speak?base=<n>`); the server turns
  it into text with Cloudflare Workers AI, has the reply rewritten from four things (the sender's first name, the six-word
  summary, the reply on screen, what you said), checks it and keeps only that new draft. The clip and its text are not
  kept, on the glasses or on the server. The app shows `Draft: <the new reply>`; `Send` → C → `Send now` posts
  `{"choice":5,"rev":"<8 hex>"}`, so only the draft you saw can leave. Speaking never sends.
- Dev-only clip (`src/dev-voice.ts`, dev server only, found in no file of `dist/`): `?clip=<a same-origin path>` (raw
  samples or a WAV) replaces the microphone, 3,200 bytes every 100 ms then silence; the walk makes its own tone at run time.
- `SOURCES` (`src/config.ts`) is mail only by default; with Telegram on, Telegram items join the same list with a « TG » tag.
  The `?sources=`, `?at=` and `?states=1` URL switches work on the dev server only.

## Screens (`docs/screens/`)

`22` to `27` are backend mode against the stub: E opened by the calendar answer (`22`), A with the answer's clock and
`next` (`23`), A when the calendar call fails (`24`), « Sign-in needed » from a 403 (`25`), « No connection » (`26`) and
the list back after the automatic retry, with no press (`27`).

Day 4: `28` to `30` are the three new F lines (static preview: `Daily send limit…`, `Already handled.`, `Not confirmed…`);
`31` to `34` are backend mode, paired through `?pair=` with the stub's `REAL_SEND` on: C after `send_failed` (`31`), `Sent`
after a real send, no demo line (`32`), `Not confirmed` after `send_unknown` (`33`), and the demo session's `Sent` with
`Demo: no real mail was sent` (`34`). Changed on day 4: `06` and `18` (the demo line), `13` and `25` (« Sign-in needed »
in three lines; `25` shows the stub's host `127.0.0.1:8788`), `24` (the device clock in the header; the walk fixes
it with the dev-only `?at=13:53`, so the PNG is the same at every run). Every other PNG is byte-identical.

Day 5 (« Speak a change », backend mode against the stub, paired through `?pair=`, the dev-only `?clip=` tone instead of
the microphone): B with four rows (`35`), D listening with the bar part full (`36`), `Rewriting…` (`37`), B with the
spoken draft (`38`), C with it (`39`), then the five lines: `Didn't hear you.` (`40`), `Couldn't change the reply.` (`41`),
`Voice limit reached.` (`42`), `That draft is gone.` (`43`, a `Send now` whose stored spoken draft is gone) and
`No microphone.` (`44`: the simulator's own microphone, no audio device in its jail). B with three rows is unchanged
(static mode never offers the voice): all 34 earlier PNGs are byte-identical.

`19-double-press-sim.png`: on a double-press the app calls the system exit dialog (`shutDownPageContainer(1)`). The
simulator (0.9.5) draws no dialog: the glasses canvas goes black. What the real glasses show is not checked yet.

## Known limits

- « Speak a change »: what the user said is read only by their own eyes on B and C: the server's check
  (`checkSpoken`) refuses a link, a long text or an unsafe one, but cannot know a wrong hour or a promise the user did not
  make; `Send` → `Send now` stays the only way out. English only, no live text while speaking. The microphone path was
  walked two ways: the screenshot walk uses the dev-only clip, and at the day-5 gate the deployed app ran in the
  simulator with a virtual microphone (below): a synthetic voice clip played into it was heard, the reply rewritten,
  shown as `Draft:` and sent as a demo send. There the first sound came 0.6 to 2.0 s after the start, so the « no
  microphone » watch is 5 s. The real glasses' microphone, its delay and its chunk size are not checked here.
  Voice in the simulator: build once `podman build -t localhost/er-sim:mic -f tools/sim-container/Containerfile.mic
  tools/sim-container`, then `SIM_MIC=1 tools/sim.sh start <url>`. The app gets 100 ms audio events (silence between
  clips; silence reads as a constant 128, not 0). `tools/sim.sh speak clip.wav` plays a 16 kHz mono WAV into it at real
  speed (start the clip with about 2.5 s of silence: sound played before the microphone has started is lost).
  `tools/mic-probe/serve.sh` serves a console probe. Limits (the server's): 12 clips per session per hour, 30 per address per hour and 40 per
  address per day, a daily budget of Workers AI units for all users (`VOICE_DAILY_NEURONS`).

- The exit dialog (double press) draws nothing in the simulator 0.9.5 (`19-double-press-sim.png` is black); real glasses not checked.
- The simulator 0.9.5 keeps the SDK storage (`setLocalStorage`) in memory only: after a dev pairing, nothing on disk holds
  it (seen 2026-11-23: no file of the simulator's home holds the key, even after a graceful `podman stop`), so a
  `sim.sh stop` + `start` comes back unpaired even with the volume; pass `?pair=` with a fresh code again. Real glasses
  keep it in the Even app (not checked here).
