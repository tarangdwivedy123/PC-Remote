# PC Remote

Control a Windows 11 PC's media playback and volume from an old Android phone
over Wi-Fi, and watch live performance stats while you do it.

A Node service runs on the PC and serves a mobile web dashboard. **There is no
Android app** — you open a URL in Chrome and optionally "Add to Home screen".
Everything stays on your LAN; there is no cloud service, relay, or account.

**Just want to use it?** Download the installer from
[the download page](https://tarangdwivedy123.github.io/PC-Remote/), run it, and
scan the QR code that appears. Nothing below this line is needed for that — the
rest of this file is for working on the code.

```
   PC (Windows 11)                      Phone (Chrome, on the same Wi-Fi)
   ┌──────────────────────┐             ┌──────────────────────────┐
   │  agent   :8765       │◄────────────┤  http://192.168.x.x:8765 │
   │  Fastify + WebSocket │   1 Hz WS   │  mobile dashboard (PWA)  │
   └──────────────────────┘             └──────────────────────────┘
```

---

## Status: all milestones complete

| # | Milestone | State |
|---|-----------|-------|
| 1 | Monorepo, agent serves client, WS handshake, PIN pairing, LAN URL + console QR | **done** |
| 2 | Stats end-to-end (agent → WS → phone charts) | **done** |
| 3 | Volume: system, then per-app | **done** |
| 4 | Media: key emulation (A), then media sessions (B) | **done** |
| 5 | System actions, PWA manifest, run-at-login | **done** |

Live now:

- **Stats** — CPU (total and per-core), RAM, disk read/write, network up/down,
  uptime, and where an NVIDIA card is present GPU load, memory and temperature.
  Sampled once a second, charted with uPlot sparklines, and backfilled from a
  rolling 120-sample history the moment the phone connects.
- **Volume** — system level and mute, plus a per-application slider for every app
  holding an audio session, so Chrome can be ducked without touching anything
  else. Windows reports one session per audio stream, so streams are grouped into
  one row per app.
- **Now Playing** — title, artist, album, artwork, live position and seek for any
  app that publishes a media session, plus which app owns it. Falls back to blind
  media keys when nothing does, so the transport buttons always work.
- **System** — lock, sleep and display-off; a sleep timer with presets or a
  custom delay; two-way clipboard sync and "open this link on the PC". Shutdown
  and restart live in the header, behind two taps and a single-use server-side
  confirmation.
- **Audio devices** — every active output endpoint, with one tap to move the
  system default between them (desk speakers, either monitor).
- **Microphone** — mute and a live input meter.
- **Brightness** — a slider per monitor over DDC/CI, alongside input switching.
- **Light and dark themes**, remembered, seeded from the OS preference.
- **Monitors** — switch a display between HDMI, DisplayPort, DVI and VGA over
  DDC/CI, so a monitor can be handed to a console or laptop and taken back
  without reaching behind it.
- **Installable** — a web app manifest and icons, so Chrome's "Add to Home
  screen" produces a real standalone launcher.

---

## Quick start

```bash
npm install
npm run build      # builds the phone client, then bundles the agent
npm start          # runs the agent
```

The agent prints a banner with the URL to open, a scannable QR code, and a
6-digit pairing PIN:

```
  PC REMOTE  v0.1.0
  ─────────────────────────────────────────────

  Open on your phone:
    http://192.168.31.240:8765

    ▀▀▀▀▀▀▀ ▀▀  ▀ ▀▀▀ ▀▀▀▀▀▀▀      (a real QR code, scan it)
    ...

  Pairing PIN:  066602
    Enter this on the phone once. It is then remembered.

  Other LAN addresses on this machine:
    http://100.64.0.7:8765  Tailscale  (CGNAT range, virtual/VPN adapter)
```

Scan the QR with your phone's camera and you are paired — the QR carries a
single-use pairing code, so the PIN is only needed when typing the address by
hand.

If the URL does not load, see [Windows Firewall](#windows-firewall) below — that
is the usual cause.

---

## Building the release

```bash
npm run dist
```

Produces two files in `release/`:

| File | What it is |
|------|-----------|
| `PCRemote-Setup.exe` | The installer. ~24 MB. Adds the firewall rule, offers autostart, registers an uninstaller. |
| `PCRemote.exe` | The same app as one portable file. ~93 MB. No install, no admin, but Windows will ask about the firewall on first run. |

Needs [Inno Setup](https://jrsoftware.org/isinfo.php) for the installer step
(`winget install JRSoftware.InnoSetup`); without it the portable exe is still
built. `postject` comes from `npm install`.

### What the build does, and why

The executable is a Node [single executable application][sea]: a copy of
`node.exe` with the bundled agent and the built web client injected into it.
Four things happen to that copy afterwards, each for a specific reason:

1. **The Authenticode signature is stripped.** It covers bytes the injection
   changes, so leaving it makes Windows call the result *corrupt* — treated far
   more harshly than merely unsigned. `signtool` does this, but it only ships in
   the Windows SDK, so `scripts/dist.mjs` clears the certificate directory entry
   and truncates instead.
2. **Name, version and icon are written** via `BeginUpdateResource`. Skip this
   and the Windows Firewall prompt asks the user to allow *"Node.js JavaScript
   Runtime"* onto their network — a name they have never heard of, on a dialog
   whose safe-looking button is Cancel.
3. **The PE subsystem is flipped to GUI**, because a console-subsystem binary
   opens a black window that lives as long as the app. There is no flag for it;
   the subsystem is a field in the PE header.
4. **The installer is compiled**, wrapping the exe with a firewall rule scoped to
   private and domain profiles — never public.

[sea]: https://nodejs.org/api/single-executable-applications.html

The web client cannot be served from inside the binary, so it is embedded as SEA
assets and unpacked once to `%LOCALAPPDATA%\PCRemote\client-<version>-<hash>`
on first launch. The hash means a changed client always re-extracts, and a
completion marker means a half-written extraction is never reused.

### The download page

`docs/index.html` is a single self-contained file, served by GitHub Pages from
the `docs/` folder. Its download button points at
`releases/latest/download/PCRemote-Setup.exe`, which is why the installer
filename carries no version number — a versioned name would break the button on
every release.

---

## Verifying everything

There is an automated suite. It boots real agents on their own ports with their
own throwaway config, so it never touches your real setup:

```bash
npm run verify
```

Expect `500/500 checks passed` across fourteen suites: the WebSocket protocol and
auth, the bundled agent serving the built client, dev-mode proxying, stats
end-to-end, the nvidia-smi and typeperf output parsers, volume (session grouping
plus a live device round-trip), media keys and sessions, system actions and the
PWA assets, monitor input switching, the old-Chrome feature floor, the React tree
rendering, the client's reassembly of delta patches, and the packaging surface —
the installer's firewall scope, the executable's identity, and the download links.

The monitor suite never switches an input. Doing so would move a real display to
another device — possibly one that is not plugged in, leaving a black screen to
fix with the monitor's own buttons. The write path was verified by hand instead,
by writing each monitor's *current* input back to itself.

The system suite runs its agent with `PCR_SYSTEM_DRY_RUN=1`, so lock/sleep/
shutdown are logged rather than performed — everything up to the final API call
is exercised for real. Nothing in `npm run verify` will suspend or power off your
machine.

The media suite presses this machine's media keys only when nothing is playing,
where they are inert — that proves the path from WebSocket to `user32` works. If
a real media session is live it skips those commands rather than pausing your
music, and says so.

The volume suite changes your real system volume by a few percent and puts it
back; it verifies the restore and reports the figure either way.

> **Run it from PowerShell or cmd, not a sandboxed shell.** The disk and network
> figures come from `typeperf`, which needs Performance Data Helper access. Some
> sandboxed shells deny that to child processes, and those two metrics then read
> zero. The suite still passes — it checks structure, not specific values — but it
> prints `(typeperf counters were unavailable in this shell)` so you know the
> numbers were not exercised.

### By hand

**1. The agent starts and prints a scannable QR.** Run `npm start`. Point your
phone's camera at the QR code — it should offer to open
`http://<your-lan-ip>:8765`. If the QR looks like a solid block instead of a
pattern, your console font lacks the half-block glyph: run with
`PCR_QR_BLOCKS=1` for a larger, glyph-free version.

**2. The LAN address is the right one.** The banner picks the highest-scoring
interface and lists the rest underneath. Virtual adapters (Hyper-V, WSL,
VirtualBox, Tailscale, VPNs) are deprioritised automatically. If it still guesses
wrong, force it: `npm start -- --lan-ip 192.168.1.42`.

**3. Pairing works and is remembered.** Enter the PIN on the phone. You should
land on the dashboard. Now force-close Chrome, reopen the URL — it should go
straight to the dashboard with no PIN prompt. The token lives in the phone's
`localStorage`.

**4. Unauthenticated access is refused.** From the PC:

```bash
curl -i http://localhost:8765/api/state          # 401
curl -i http://localhost:8765/api/session        # 401
curl -sX POST http://localhost:8765/api/pair \
  -H 'content-type: application/json' -d '{"pin":"000000"}'   # 401 Wrong PIN
```

Try the wrong PIN six times in a row and you will be locked out for 30s, with the
lockout doubling on each repeat. That is deliberate: a 6-digit PIN is only a
million possibilities, so without throttling it would fall in seconds on a LAN.

**5. The 1 Hz broadcast is live.** On the dashboard, scroll to the **Link**
card at the bottom. "Last frame" should sit under 1000 ms and "Snapshot" should
tick every second. Round-trip time on Wi-Fi is usually 2–20 ms.

**6. Reconnection recovers silently.** With the dashboard open on the phone:

- Turn Wi-Fi off. Within ~6 seconds the header switches to "Reconnecting" with a
  countdown. (Six seconds because the socket stays `OPEN` as far as the browser
  is concerned when you walk out of range — a watchdog notices the silence.)
- Turn Wi-Fi back on. It reconnects immediately rather than waiting out the
  backoff, and the charts continue.
- Now stop the agent with Ctrl-C, leave it down for a minute, and restart it. The
  phone should reconnect on its own — backoff caps at 15 s, so you never wait
  longer than that.
- Lock the phone, wait a minute, unlock it. It reconnects on becoming visible
  rather than showing a frozen dashboard.

**7. Re-pairing is forced when tokens are revoked.** Run
`npm start -- --revoke-all`, then restart the agent. The phone should notice its
token is dead and return to the PIN screen by itself. (This path exists because
a rejected WebSocket upgrade gives the browser only close code 1006 — the client
asks `/api/session` to tell "not paired" apart from "PC is off".)

### Milestone 2 by hand

**8. The charts are populated the instant the page loads.** Leave the agent
running for at least two minutes, then open the dashboard on the phone (or
hard-refresh it). The sparklines should already show ~120 samples of history
rather than drawing in from empty — the agent replays its rolling buffer on
connect. A freshly started agent legitimately shows a short window.

**9. The numbers are real.** Compare against Task Manager's Performance tab:

- **CPU** — start a build (`npm run build`) and watch it climb. The per-core bars
  below the sparkline should light up unevenly; a single-threaded load should
  drive one bar far higher than the rest.
- **RAM** — should match Task Manager's "In use" figure closely.
- **Disk** — copy a large file. Expect a burst rather than a smooth plateau:
  Windows buffers writes in the file cache and flushes them lazily, so the
  physical-disk counter is genuinely spiky even during steady copying.
- **Network** — start a download, or just run `npm install`.
- **GPU** — on a machine with an NVIDIA card, the row shows load, memory and
  temperature. Without one, **there should be no GPU row at all** (see above).

**10. Nothing is quietly missing.** Check the agent console at startup:

```
info [stats] sampling every 1000ms (4 logical cores)
info [perf]  streaming 6 performance counters via typeperf
info [gpu]   monitoring NVIDIA GeForce RTX 3070      <- only with an NVIDIA card
```

If the `[perf]` line is absent and you see a warning about "no valid counters",
disk and network will read zero — grant Performance Log Users membership as
described above. If the `[gpu]` line is absent, that is normal on any machine
without an NVIDIA card.

**11. The agent stays cheap.** Find the agent's `node.exe` in Task Manager's
Details tab. It should sit at roughly 0–1% CPU while broadcasting. If it is
visibly busy, something slow got into the tick path — that is the failure mode the
table above exists to prevent.

**12. Helper processes are cleaned up.** With the agent running, confirm
`typeperf.exe` exists:

```powershell
Get-Process typeperf -ErrorAction SilentlyContinue
```

Stop the agent with Ctrl-C, then run it again — it should return nothing. Orphaned
counter processes would otherwise accumulate across restarts.

**13. The charts stay smooth on the old phone.** Scroll the dashboard up and down
for a while with all five charts live. It should stay responsive; uPlot is used
precisely because a React charting library will not on this hardware.

### Milestone 3 by hand

**14. System volume works both ways.** Move the top slider on the phone and watch
the Windows volume flyout follow it. Then change the volume *on the PC* (keyboard
keys or the tray icon) — the phone's slider should follow within a second. Tap the
speaker icon to mute; the slider dims and the readout says "muted".

**15. Per-app volume — the point of the whole milestone.** Start something playing
in Chrome and something in another app (Spotify, VLC, a game). Both should appear
as their own rows within a second, labelled the way the Windows volume mixer
labels them ("Google Chrome", not "chrome").

Now drag Chrome's slider down. **Only Chrome should get quieter** — the other app
and the system level must not move. Cross-check in the Windows volume mixer
(right-click the tray speaker → Open Volume mixer); the per-app sliders there
should match the phone.

**16. Dragging is smooth and does not fight you.** Drag a slider back and forth
quickly for several seconds. The thumb should track your finger without snapping
backwards, and audio should follow continuously rather than in lurches. State
broadcasts arrive every second during the drag, and the slider deliberately
ignores them while your finger is down.

**17. Multiple Chrome tabs still show one row.** Play audio in two or three Chrome
tabs at once. Chrome should stay a **single** row, and moving it should affect all
of them — Windows exposes one session per renderer, which the agent groups.

**18. Apps come and go cleanly.** Close the app you were playing. Its row should
disappear within a second or two rather than lingering at a stale level. Start it
again and it reappears.

**19. Idle apps are dimmed, not hidden.** Pause playback without closing the app.
The row should stay, dimmed, so you can still set its level before unpausing.

**20. Volume survives an agent restart.** Ctrl-C the agent and start it again. The
phone reconnects and the volume section repopulates. Your levels are Windows'
state, not the agent's, so nothing should have been reset.

### Milestone 4A by hand

**21. Transport controls drive whatever is playing.** Start a YouTube video in
Chrome, or Spotify. Tap play/pause on the phone — playback should stop. Tap it
again. Try next and previous with a playlist or queue.

Then switch: pause Chrome, start Spotify instead, and use the phone again. The
buttons should now control Spotify with no configuration, because Windows routes
media keys to whichever app currently owns playback. That is the whole point of
milestone A.

**22. The play/pause button does not pretend to know the state.** The icon is a
combined play-and-pause glyph, and the section is labelled "media keys". This is
deliberate: media keys report nothing back, so any play-versus-pause icon would be
a guess that silently inverts the moment you press pause on the PC itself.
Milestone B replaces this with the real status.

**23. Nothing playing is harmless.** With all media closed, tap the buttons. They
should be accepted without error and simply do nothing — the keys go out, and no
app claims them.

### Milestone 4B by hand

**24. A session upgrades the card live.** With nothing playing, Now Playing shows
"media keys" and transport buttons only. Start a YouTube video in Chrome, or
Spotify. Within a second the card should gain the track title, artist, artwork,
a scrubber, and the app's name in the header.

**25. The metadata is real.** Compare against the Windows media flyout (press a
volume key). Same title, same artist, same artwork — both read the same API.

**26. Play and pause are distinct now.** The icon should show a real pause symbol
while playing and a real play symbol while paused, and follow changes made *on
the PC*. Press pause in Chrome directly; the phone's icon should flip within a
second.

**27. Pressing play while already playing does nothing.** This is worth checking
explicitly — it was a bug during development, where a redundant press fell
through to a blind media key and paused the music instead.

**28. Seek works.** Drag the scrubber. Playback should jump, and the elapsed time
should follow. Note that seek fidelity is the app's business: Chrome and Spotify
honour it, Windows Media Player accepts it and ignores it.

**29. The position moves smoothly.** The agent reports position once a second but
the bar is extrapolated between updates, so it should sweep rather than tick.

**30. Artwork is not re-sent constantly.** Open Chrome's DevTools against the
dashboard (or just watch the Link card). `/api/media/thumbnail` should be fetched
once per track, not once per second — the state carries only an id.

**31. Closing the app drops back cleanly.** Close Spotify/Chrome. Within a second
or two the card should return to the "media keys" form rather than freezing on
the last track.

### Milestone 5 by hand

**32. Monitor inputs.** The Monitors card lists each display with its inputs, the
current one highlighted. Tap another input — the monitor should switch within a
second or so.

Before doing this, read the warning above: if you switch a monitor to an input
with nothing attached, you get a black screen and may need the monitor's buttons
to get back. Switch to something you know is connected first.

**39. It refuses inputs your monitor does not have.** This is enforced by the
agent, not just hidden in the UI — the value must appear in the monitor's own
capabilities list.

**40. The scan happens once.** Watch the console on first start:
`2 display(s), 2 with switchable inputs (scan took 6555ms, cached for next time)`.
Restart the agent and it should instead say
`input lists for 2 display(s) came from cache`.

**41. The recoverable actions.** Tap **Display off** — the monitor should go dark
and wake on a keypress or mouse move. Tap **Lock** — you should land on the
Windows lock screen. Tap **Sleep** — the PC suspends; wake it as usual. All three
are recoverable by walking over to the machine, which is why they are one tap.

**33. Shutdown needs two taps and does not linger.** Tap **Shut down** once: it
turns red and reads "Tap again to shut down". Now *wait*. After about six seconds
it should revert on its own — a stray tap must not leave a live trigger on
screen. (Do this before testing the real thing.)

**34. Shutdown actually works.** Tap twice in quick succession. The PC shuts
down. `/f` is deliberately not passed, so an app with unsaved work can still
block it — you will get the usual "apps prevented shutdown" screen rather than
losing anything.

**35. The confirmation is enforced by the agent, not just the UI.** From the PC,
with a paired token:

```bash
# No confirmation: rejected by the schema.
curl -sX POST http://localhost:8765/api/state -H "authorization: Bearer $TOKEN"
```

The phone's two taps are convenience. The real gate is a single-use token from
`/api/confirm-token` that expires in 30 seconds, so a replayed or forged frame
cannot power the machine off. `npm run verify` covers forged, cross-action and
replayed tokens.


**37. Add to Home screen.** Chrome menu → "Add to Home screen". The icon should
be the teal screen-and-bars mark, and launching it should open **without browser
chrome** — no address bar. If you get an address bar, the manifest was not
picked up; hard-refresh once and retry.

**38. Run at login.** See below. After registering the task, reboot and check the
phone can reach the dashboard without you starting anything.

---

## Development

```bash
npm run dev
```

Runs the agent with file watching **and** the Vite dev server with hot module
reload, both bound to `0.0.0.0`.

In development the phone loads the app from **Vite on port 5173**, not from the
agent — that is what makes hot reload work on the device. Vite proxies `/api` and
`/ws` straight through to the agent on 8765. The banner prints the 5173 URL while
in dev mode and reminds you of the production one.

Editing anything under `client/src` updates the phone in about a second, which
matters a lot when you are tuning touch targets on real hardware.

Other scripts:

| Command | What it does |
|---------|--------------|
| `npm run typecheck` | `tsc --noEmit` across all three TypeScript workspaces |
| `npm run verify` | The automated milestone suite |
| `npm run build` | Client bundle, then a single-file agent at `agent/dist/agent.mjs` |
| `npm start -- --show-pin` | Print the current PIN and config path |
| `npm start -- --reset-pin` | New PIN; already-paired devices keep working |
| `npm start -- --revoke-all` | Un-pair every device |
| `npm start -- --help` | All flags and environment variables |

### Layout

```
agent/    Node + TypeScript service that runs on the PC
client/   Vite + React + Tailwind mobile dashboard
shared/   Types and wire protocol used by both (zero runtime dependencies)
helper/   C# console app for Windows media session info (Milestone 4B)
vendor/   nircmd.exe — you download this, see vendor/README.md (not needed yet)
scripts/  Build helpers and the verification suite
```

`shared/` is deliberately dependency-free so nothing it exports can bloat the
phone bundle. The zod schemas that validate commands live in the agent instead,
with a compile-time assertion that they still match the hand-written types in
`shared/` — so the two cannot drift apart silently.

---

## Where the stats come from

Worth reading before changing `agent/src/stats/`, because the obvious
implementation does not work on Windows and the reasons are not guessable.

Everything is sampled on one 1000 ms timer shared by all clients. That cadence is
only affordable because **nothing in the tick path shells out**. Measured on the
target machine (i3-9100T, 4 cores, 8 GB):

| Source | Cost | Used? |
|---|---|---|
| `si.currentLoad()` | ~0 ms | **yes** — CPU total + per-core, pure Node `os.cpus()` deltas |
| `os.totalmem()` / `os.freemem()` | ~0 ms | **yes** — RAM |
| `os.uptime()` | ~0 ms | **yes** — uptime |
| `os.cpus()[0].model` | ~0 ms | **yes** — CPU brand string |
| `si.mem()` | 425 ms | no — reports `active == used` and `buffcache == 0` on Windows, so `os.freemem()` carries identical information for free |
| `si.networkStats()` | 240 ms | no — too slow for a 1 Hz tick |
| `si.cpuTemperature()` | 479 ms | no — returns all nulls on this CPU anyway |
| `si.cpu()` | 1716 ms | no — static data; `os.cpus()` gives the same brand |
| `si.fsStats()` | — | **cannot** — returns `null` on Windows |
| `si.disksIO()` | — | **cannot** — returns `null` on Windows |

Calling the slow four on a one-second timer would cost roughly 1.15 s of CPU per
second of wall clock: a system monitor that becomes the thing worth monitoring.
The verification suite asserts none of them reappear in the sampler.

Since `systeminformation` cannot provide disk or network throughput on Windows at
all, those come from two **long-lived child processes** instead, each parsed in
the background so a tick just reads the last value:

- **Disk + network** — `typeperf`, built into Windows, streaming these PDH
  counters at `-si 1`: `\PhysicalDisk(_Total)\Disk Read Bytes/sec`, the matching
  write counter, and `\Network Interface(*)\Bytes Received/sec` + `Bytes Sent/sec`.
  The `(*)` wildcard yields one column per adapter; real NICs are summed and
  loopback/isatap/teredo/tunnel pseudo-adapters are filtered out. The first data
  line is discarded, since a rate counter's first sample is measured against
  process start rather than a previous sample.
- **GPU** — `nvidia-smi --query-gpu=… --loop-ms=1000`, one process rather than 60
  spawns a minute (it takes 100–300 ms to start). A one-shot probe runs first to
  detect whether it exists and read the card name.

Both restart on death with a cap, and both degrade to omitting their metrics
rather than failing the page.

### Two caveats

**`typeperf` needs Performance Data Helper access.** Your account must be in
`Administrators` or `Performance Log Users`. Without it, typeperf exits with
"No valid counters", the agent logs a one-line explanation and stops retrying
(it will never succeed), and disk/network read zero. Everything else keeps
working. To grant it without elevating the agent:

```powershell
# From an elevated prompt, once:
Add-LocalGroupMember -Group "Performance Log Users" -Member $env:USERNAME
# Log out and back in for the token to pick up the new group.
```

**Counter names are English.** PDH counter names are localised, so on a
non-English Windows install none of them resolve and disk/network are omitted.
The language-neutral numeric form (`\234(_Total)\220`) was tried and does not
resolve on Windows 11 either, so there is no better fallback to reach for.

### No NVIDIA GPU

The `gpu` field is **omitted from the state object entirely**, not sent as null or
zero, and the phone renders no GPU row at all. A zeroed row on an
integrated-graphics machine would look like a GPU sitting at 0%, which is worse
than no row. If a GPU appears or disappears mid-session the delta carries an
explicit deletion marker, so the row appears and vanishes correctly.

---

## How volume control works

> **Deviation from the brief, on request.** The original plan was to bundle
> NirSoft's `svcl.exe` and shell out to it. That was dropped in favour of talking
> to Windows Core Audio directly, so **no third-party binary is needed** for
> volume. `vendor/svcl.exe` is not used and does not need to be downloaded.

The agent drives `IMMDeviceEnumerator`, `IAudioEndpointVolume` and
`IAudioSessionManager2` through C# interop, which gives system volume, system
mute, and a per-application level and mute for every app holding an audio session
— the "duck Chrome without touching everything else" case.

### One long-lived PowerShell host, not a process per command

The C# is compiled at startup with `Add-Type` and the process is kept alive,
speaking one JSON object per line over stdin/stdout. Measured here:

| | cost |
|---|---|
| `Add-Type` compiling the interop | **~600 ms**, once at startup |
| enumerate all sessions | ~2.2 ms |
| set a volume | ~2 ms |

A PowerShell process per command would pay that 600 ms every time. With the
100 ms-debounced slider the brief asks for, dragging would queue compilations
faster than they complete and peg a core on a 4-core machine. The same reasoning
produced the `typeperf` and `nvidia-smi` designs in the stats section.

Writes are coalesced on a 100 ms window, so a fast drag issues one COM call per
100 ms rather than one per pixel, and the value is echoed back optimistically so
the slider does not snap backwards while a write is in flight.

### Sessions are grouped per application

Windows reports one session **per audio stream**, so Chrome routinely appears
three or four times — one per renderer. Rows are grouped by process, and a write
applies to every stream that process owns; changing only the first would move the
slider without changing what you hear. The displayed level comes from an actively
playing stream, because an app's idle streams usually sit at 100% regardless.

Apps that hold a session without currently playing stay in the list, dimmed, so
you can duck something before it starts. Expired sessions are dropped.

### Two details worth knowing

**Session ids are `process:pid`, not bare pids.** Windows recycles pids, and a
slider write can arrive after the app it targeted has exited. The agent re-checks
the process name before applying, so a stale write is discarded instead of
silently muting whatever inherited the pid.

**`IsSystemSoundsSession` needs `[PreserveSig]`.** It and `SetDuckingPreference`
are the only interop methods with no `[out]` parameter. Without the attribute the
marshaller consumes the HRESULT and the declared `int` return is meaningless —
every session then reports as system sounds, and the per-app list becomes
useless. This cost real debugging time; there is a check in the verification
suite so it cannot come back.

### If it is unavailable

A machine with no playback device, or a PowerShell that will not start, leaves
`volume.unavailable` set with a reason. The phone shows that reason and disables
the controls; everything else keeps working.

---

## Child processes and cleanup

The agent runs up to three helper processes: `typeperf` (disk and network),
`nvidia-smi` (GPU, only if present), and the PowerShell audio host. A clean
shutdown (Ctrl-C) stops all of them.

An *unclean* exit — a crash, or Task Scheduler's "End task" — is harder, because
Windows does not terminate children along with their parent:

- The **audio host** watches the agent's pid and exits within a second of it
  disappearing. This is possible because it is our code.
- **`typeperf`** cannot be made to do that, and it does not exit when the pipe it
  writes to closes (verified by killing an agent and watching it run on
  indefinitely). It is therefore launched with a one-hour sample cap, so an
  orphan retires itself within the hour. Reaching the cap during normal operation
  restarts it immediately and is not treated as a failure, so the gap in
  disk/network data is well under a second.

If you ever want to check for strays:

```powershell
Get-Process typeperf -ErrorAction SilentlyContinue
Get-CimInstance Win32_Process -Filter "Name='powershell.exe'" |
  Where-Object { $_.CommandLine -like '*pcr-audio-host.ps1*' }
```

---

## Pairing and security model

This is a LAN-only tool and the security model is scoped to that. It is **not**
built to survive exposure to the internet — do not port-forward it.

**How pairing works.** There are two ways in, and both end at the same bearer
token.

*Scanning the QR* is the normal path. The QR encodes `http://IP:8765/?p=<code>`,
where the code is 256 bits of `randomBytes`, held in memory only and **rotated
the moment it is spent**. The client reads it, strips it from the URL with
`history.replaceState` before the first render, and POSTs it to `/api/pair`. No
PIN, no typing.

*Typing the PIN* is the fallback for when a camera will not cooperate. On first
run the agent generates a random 6-digit PIN and saves it to `config.json`.

Either way `/api/pair` returns a 256-bit bearer token. Only the token's SHA-256
is written to disk; the raw value exists in the phone's `localStorage` and
nowhere else. Every API call carries it as `Authorization: Bearer …`, and the
WebSocket carries it as a query parameter, because the browser WebSocket API
cannot set request headers.

The pairing code deliberately **skips the failure throttle** that guards the PIN.
Two reasons: 256 bits is not brute-forceable, so the throttle buys nothing; and
sharing the counter would let anyone spraying bad codes at the agent lock the
owner out of their own PIN.

The code is never exposed over HTTP — there is no endpoint that hands it out.
The first-run window receives it over the tray's local pipe, which is why the QR
on screen works and a request from the network cannot ask for one.

**Defences in place.**

- The WebSocket upgrade is authenticated during the HTTP handshake, so an
  unauthenticated socket is rejected with a real 401 and never receives a frame.
- Pairing attempts are throttled per IP: 5 failures per minute triggers a
  lockout that doubles from 30 s up to 15 minutes.
- Every inbound frame is validated with zod before it reaches a handler.
  Malformed frames get an error response and do not close the socket.
- Commands are rate-limited per connection with a token bucket, weighted by cost
  — a volume drag is cheap, a shutdown is expensive.
- Requests from outside RFC1918/loopback ranges are refused outright, as a
  backstop against the port being exposed by accident. `PCR_ALLOW_ANY_IP=1`
  disables that, and you should not need it.
- `trustProxy` is off, so `X-Forwarded-For` cannot be used to fake a source IP
  past the LAN guard or the throttle.
- Shutdown and restart require a single-use, 30-second confirm token fetched over
  HTTP, so a stray or replayed WebSocket frame cannot power the machine off.

**Known limitations, stated plainly.**

- Traffic is plain HTTP. Anyone already on your Wi-Fi can read it and could
  replay a captured token. TLS is not worth it here: a self-signed certificate on
  a LAN IP means permanent browser warnings, and it protects against an attacker
  who is already inside your network.
- The PIN is stored in cleartext in `config.json` so you can read it back if you
  lose the console scrollback. Hashing 10⁶ possibilities would not meaningfully
  slow an attacker who already has the file. The file is written mode `0600`.
- Anyone on your LAN who knows the PIN can pair. Rotate it with `--reset-pin`.

Config lives at `%APPDATA%\pc-remote\config.json`. Override with `PCR_DATA_DIR`.

---

## Windows Firewall

Windows blocks inbound connections to Node by default, so the phone will not
reach the agent until you allow port 8765. **Private profile only** — never add
this rule to the Public profile.

Run this in an **Administrator** PowerShell, once:

```powershell
New-NetFirewallRule `
  -DisplayName "PC Remote agent (LAN only)" `
  -Direction Inbound `
  -Action Allow `
  -Protocol TCP `
  -LocalPort 8765 `
  -Profile Private `
  -RemoteAddress LocalSubnet `
  -Description "Allows phones on the local subnet to reach the pc-remote agent."
```

`-RemoteAddress LocalSubnet` is the important part: it restricts the rule to your
own subnet, so the port is not open to anything a VPN or a guest network might
bring along.

Verify and, if you ever want it gone:

```powershell
Get-NetFirewallRule -DisplayName "PC Remote agent (LAN only)" |
  Format-List DisplayName, Enabled, Profile, Action

Remove-NetFirewallRule -DisplayName "PC Remote agent (LAN only)"
```

**Check which profile your network is on.** The rule only applies if Windows
considers your Wi-Fi "Private":

```powershell
Get-NetConnectionProfile | Format-List Name, NetworkCategory, InterfaceAlias
```

If it says `Public`, either change it in Settings → Network → Wi-Fi → *your
network* → Private, or:

```powershell
Set-NetConnectionProfile -Name "YourWiFiName" -NetworkCategory Private
```

If the phone still cannot connect, confirm the agent is actually listening on all
interfaces rather than just loopback:

```powershell
Get-NetTCPConnection -LocalPort 8765 -State Listen | Format-List LocalAddress, LocalPort
# LocalAddress should be 0.0.0.0, not 127.0.0.1
```

---

## Firewall and run-at-login, in one script

Both steps are scripted. Run with `-WhatIf` first if you would rather read the
plan than trust it:

```powershell
npm run build
powershell -ExecutionPolicy Bypass -File scripts\install-windows.ps1 -WhatIf
powershell -ExecutionPolicy Bypass -File scripts\install-windows.ps1
```

It does two things:

1. **A firewall rule** for TCP 8765 on the **Private** profile only. This needs an
   elevated prompt; run unelevated and it prints the one-line command to run
   yourself rather than failing. The Private-profile scoping is the important
   part — a rule on Public would open the port on café and hotel Wi-Fi, which is
   the one thing this project must never do.
2. **A scheduled task** that starts the agent at logon, unelevated
   (`-RunLevel Limited`), with a 20-second delay so the network stack is up
   before the agent works out which interface is the LAN one. It restarts up to
   three times if it crashes and has no execution time limit.

Start it without logging out:

```powershell
Start-ScheduledTask -TaskName 'PC Remote agent'
```

Undo everything:

```powershell
powershell -ExecutionPolicy Bypass -File scripts\install-windows.ps1 -Remove
```

A scheduled task is better than a Startup-folder shortcut here: it runs without a
console window, restarts itself if it crashes, and starts before you open any
apps. The agent is deliberately **not** run as administrator — it listens on the
network and needs no elevated rights, and running a network service as admin for
no reason is a bad habit.

### Doing it by hand

<details>
<summary>The equivalent commands, if you would rather not run a script</summary>

```powershell
# Firewall (elevated prompt)
New-NetFirewallRule -DisplayName 'PC Remote (LAN)' -Direction Inbound `
  -Action Allow -Protocol TCP -LocalPort 8765 -Profile Private

# Scheduled task (normal prompt)
$node = (Get-Command node).Source
$entry = "$PWDgent\distgent.mjs"
$action = New-ScheduledTaskAction -Execute $node -Argument "`"$entry`"" -WorkingDirectory $PWD
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
$trigger.Delay = 'PT20S'
$principal = New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\$env:USERNAME" `
  -LogonType Interactive -RunLevel Limited
Register-ScheduledTask -TaskName 'PC Remote agent' -Action $action `
  -Trigger $trigger -Principal $principal
```

Check the agent is listening on the LAN and not just loopback:

```powershell
Get-NetTCPConnection -LocalPort 8765 -State Listen |
  Select-Object LocalAddress, LocalPort
# LocalAddress should be 0.0.0.0, not 127.0.0.1
```

</details>

## Monitor input switching

Every display exposes a small control channel on its video cable (DDC/CI). VCP
code `0x60` is "Input Source Select", so writing it tells a monitor to switch
between DisplayPort, HDMI and the rest — the same thing its front buttons do.

On the development machine:

| Monitor | Reports | Inputs it advertises |
|---|---|---|
| ViewSonic VX3276-FHD | `0x0F` DisplayPort 1 | VGA 1, DVI 1/2, DP 1/2, HDMI 1/2 |
| Acer EK221Q E3 | `0x11` HDMI 1 | VGA 1, HDMI 1 |

### The one thing to know before tapping

Switching a monitor away from this PC means it is now showing another device.
**Whether it still answers this PC afterwards is up to the monitor.** Many keep
responding on the inactive cable and can be switched back from the phone; some
stop, and then only the monitor's own buttons will bring it back.

That is a property of the display, not something the agent can fix, so the UI
says so plainly rather than pretending otherwise.

### Why it is built the way it is

**The capabilities string is the only trustworthy list of inputs.** Reading the
current input also returns a `max` value, and it is wrong: the Acer reports
`max=0x03` while sitting on `0x11`. Trusting it would offer inputs that do not
exist and hide the one in use. The agent parses the monitor's own
`60(01 03 04 0F 10 11 12)` list instead, and **refuses any value the monitor did
not advertise** — parking a display on a dead input is exactly the mistake that
needs the buttons behind the panel to undo.

**That list costs 2 to 3.5 seconds per display to read**, which caused the two
design decisions worth knowing about:

- It is **cached to disk** (`monitor-capabilities.json`, beside `config.json`)
  keyed by each monitor's plug-and-play id. The scan happens once ever, not once
  per agent start. Plug in a different monitor and only the new one is scanned.
- The scan runs in **its own throwaway PowerShell process**, shut down as soon as
  it finishes. The shared interop host handles one request at a time, so running
  a six-second DDC conversation there would stall every volume, media and system
  command behind it — a play/pause press during startup would simply time out.
  That was a real bug during development, caught by the media suite.

The recurring poll reads only the current input, which costs ~125 ms for two
displays, and runs every 10 seconds rather than on the 1 Hz tick. Nothing changes
a monitor's input except a person, so a few seconds of staleness costs nothing —
and a switch made from the phone refreshes immediately.

### If a monitor does not appear

- **DDC/CI is often off by default.** Look for it in the monitor's own menu,
  usually under Setup or System.
- **Laptop internal panels** generally do not support it at all.
- Some KVMs and long or cheap cables break the channel while carrying video fine.

A display that cannot be controlled is listed with the reason rather than hidden,
and one that advertises no inputs is left out of the card entirely.

---

## System actions and PWA install

### The five actions

| Action | How | Gate |
|---|---|---|
| Lock | `LockWorkStation` | one tap |
| Sleep | `SetSuspendState(false, false, false)` | one tap |
| Display off | `WM_SYSCOMMAND` / `SC_MONITORPOWER` broadcast | one tap |
| Restart | `shutdown /r /t 0` | two taps **and** a server-side token |
| Shut down | `shutdown /s /t 0` | two taps **and** a server-side token |

The first three go through the interop host as direct API calls — no process
spawn, and `SetSuspendState` is called with explicit arguments rather than via
`rundll32 powrprof.dll,SetSuspendState`, which is notorious for hibernating
instead of sleeping because it mis-parses its command line.

Shutdown and restart use Windows' own `shutdown.exe` with **fixed** argument
arrays. Nothing from a client frame reaches a command line anywhere: this is five
specific actions, not a way to run things. `/f` is deliberately omitted, so an
application with unsaved work can still block a shutdown — losing work to a
mis-tap on a phone is a worse outcome than a shutdown that needs confirming at
the desk.

### Why two gates on the destructive pair

The phone's confirm-twice UI is convenience, not security — it lives on the
client, where a malformed or replayed frame does not go through it. So the agent
enforces its own gate: `/api/confirm-token` mints a **single-use** token for one
specific action with a 30-second life, and the command must carry it.

That means a forged frame, a replayed frame, or a token minted for *shutdown*
being used for *restart* are all refused. The verification suite covers each.

The armed state on the phone reverts by itself after six seconds, so a stray
first tap cannot leave a live trigger sitting on screen.

### Testing without shutting your PC down

```bash
PCR_SYSTEM_DRY_RUN=1 npm start
```

System actions are then logged rather than performed. `npm run verify` sets this
for its own agent — running the suite will never suspend or power off the machine.

### Add to Home screen

`client/public/manifest.webmanifest` plus two generated icons. `display:
standalone` is what makes the launcher open without an address bar; without it
"Add to Home screen" produces a browser bookmark.

The icons are generated by `node scripts/make-icons.mjs`, which writes real PNGs
with a small hand-rolled encoder — the project has no image toolchain, and the
mark is simple enough that a few filled rectangles do the job. They are committed,
so a normal build never runs it. Both are declared `maskable` and keep the glyph
inside the middle 80%, because Android crops to whatever shape the launcher uses.

**There is deliberately no service worker.** One would satisfy Chrome's automatic
install-prompt criteria, but the only thing it could usefully cache is the app
shell — and a stale shell served after an agent upgrade is a genuinely nasty
thing to diagnose. Manual "Add to Home screen" needs only the manifest, and this
dashboard is useless without the agent reachable anyway, so there is nothing to
gain offline.


---

## Media control: Milestone A vs B

Two mechanisms. Which one is active changes what the phone can show, and the
`Now Playing` card reports it.

> **Deviation from the brief, on request.** Milestone B was specified as a C#
> console app in `helper/`. It is instead reached from the PowerShell helper the
> agent already runs, because building a C# app requires the .NET SDK and the
> point of the earlier `svcl.exe` decision was to avoid extra installs. The API
> is identical — `GlobalSystemMediaTransportControlsSessionManager`, the one
> behind the Windows media flyout — so the capability is the same. `helper/` is
> unused.

### Milestone A — media keys (`backend: "keys"`)

The agent synthesises the same virtual key presses as a keyboard's play/pause,
next, previous and stop buttons (`keybd_event` on `user32`, not nircmd). Windows
routes them to whatever owns playback.

- **Works with everything**, including apps that publish nothing to Windows.
- **Write-only.** No title, artist, artwork, position, or seek.
- **Reports `status: "unknown"` and shows a combined play/pause icon.** This is
  deliberate. Tracking a local flag and flipping it on each press looks right for
  about thirty seconds, then silently inverts the moment playback changes on the
  PC itself, a track ends, or another app takes over. A button that lies about
  state is worse than one that admits it does not know.

### Milestone B — media sessions (`backend: "smtc"`)

- **Full metadata**: title, artist, album, real playback status, position,
  duration, artwork, and which app owns the session.
- **Precise control.** Play and pause are distinct operations rather than a
  toggle, so pressing play on something already playing does nothing instead of
  pausing it.
- **Seek**, when the session reports it supports it *and* a duration is known.
- **Per-session capabilities.** Next and previous are greyed out when the app
  says it cannot do them.

Artwork is fetched from `/api/media/thumbnail`, not inlined in the broadcast: a
cover is tens of kilobytes and would otherwise be re-sent sixty times a minute.
The state carries only a `thumbnailId`, which changes when the track does, so the
phone caches each image and re-fetches only on a change.

### How they interact

The backend is chosen **per poll**, not once at startup:

| Situation | Backend |
|---|---|
| An app holds a media session | `smtc` |
| Session API works, but nothing is playing | `keys` |
| Session API unavailable (older Windows) | `keys` |

So a session appearing upgrades the card live, and closing the app drops it back
to plain transport buttons.

**One thing deliberately not done:** when a media session declines an action,
the agent does *not* retry with a blind media key. That "fallback" was
implemented, and it was a bug — `TryPauseAsync` on an already-paused session
correctly returns false, and the key that followed resumed playback, so pressing
pause started the music. A declined action is information, not something to route
around.

### Fidelity depends on the app

The agent reports what the session reports. Apps vary:

- **Good citizens** (Spotify, Chrome, Edge): accurate status, duration, working
  seek.
- **Windows Media Player** understates: for some files it reports `paused` while
  the position advances, and accepts a seek without honouring it.

If something looks wrong, check the Windows media flyout (press a volume key) —
it reads the same API, so it will show the same thing.

---

## Third-party binaries

`nircmd.exe` (media keys, display off, milestone 4A) is the only third-party
binary this project uses, and it is not committed to the repo. Download it from
nirsoft.net and drop it in `vendor/` — see
**[vendor/README.md](vendor/README.md)** for the link and how to check the
signature.

**Volume needs nothing from this folder.** `svcl.exe` was in the original plan and
is not used: per-app volume goes through Windows Core Audio directly. See
[How volume control works](#how-volume-control-works).

If a binary is absent nothing crashes: the affected feature reports as
unavailable and the phone disables those controls.

---

## Notes on the old phone

The client is built for Chrome ~70 as a floor, which rules out a lot of things
that fail *silently* rather than loudly:

- **No flexbox `gap`** (Chrome 84). It collapses to zero spacing with no error,
  so layouts use grid gaps or margin utilities instead. `npm run verify` fails the
  build if a `flex` and a `gap-*` class ever end up on the same element.
- **No `aspect-ratio`** (Chrome 88), `:has()` (105), container queries (105),
  `backdrop-filter` (76), `dvh` units (108), or the `inset` shorthand (87).
- `build.cssTarget` is pinned to `chrome70` so the CSS minifier cannot emit
  `oklab()`/`color-mix()`, which old Chrome drops on the floor.
- The bundle compiles to **ES2015** with core-js polyfills injected for missing
  built-ins, plus a `nomodule` legacy bundle as a fallback for anything that
  ignores `<script type="module">` entirely.

Setting the ES2015 target is less direct than it looks: `@vitejs/plugin-legacy`
overwrites `build.target` whenever legacy chunks are enabled, so
`client/vite.config.ts` reclaims it from a `post` plugin. The comments there
explain why the plugin's own `modernTargets` option is not the answer.

**The theme is built for an always-on AMOLED screen.** Pure black backgrounds,
structure from 1px borders rather than raised light surfaces, desaturated
accents, and no large or static bright areas — so the phone can sit propped on
the desk without burn-in or glare. Touch targets are at least 48px.

---

## Troubleshooting

**Phone shows "Could not reach the PC."** Firewall (see above), or the phone is
on a guest network / 5 GHz band that is isolated from the PC. Confirm they are on
the same subnet — the first three octets of both IPs should match.

**Banner shows the wrong IP.** Force it: `npm start -- --lan-ip 192.168.1.42`.
The banner lists the alternatives it rejected and why.

**QR renders as a solid block.** Your console font has no `▀` glyph. Use
`PCR_QR_BLOCKS=1`.

**`EADDRINUSE` on startup.** Another agent is already running. Check Task
Manager for `node.exe`, or use a different port: `npm start -- --port 8790`.

**Build fails with `EPERM` on `client/dist`.** OneDrive is holding the previous
build's files open while it syncs. The build retries automatically; if it keeps
failing, exclude the project folder from OneDrive sync or move it outside
OneDrive. This repo lives under OneDrive, so it comes up.

**Phone loads an old version after a rebuild.** `index.html` is served
`no-cache` and hashed assets `immutable`, so this should not happen — but if you
added it to the home screen before a protocol change, the header shows a "reload
me" banner. Pull down to refresh, or clear the site data in Chrome.

---

## License

MIT — see [LICENSE](LICENSE).
