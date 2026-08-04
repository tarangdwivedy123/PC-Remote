# `helper/` — Windows media session helper (Milestone 4B)

A small C# console app that reads the Windows "now playing" session and prints it
as JSON. Not built yet — it arrives in **Milestone 4, part B**.

## Why this exists

Milestone 4A controls media by emulating the keyboard media keys. That works with
whatever is currently playing, but it is *write-only*: there is no way to ask
Windows what the title is, who the artist is, how far into the track you are, or
which app owns playback.

That information lives behind a WinRT API,
`Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager` (SMTC),
which is not reachable from Node without a native addon. A tiny C# process is the
cheaper, more debuggable route: the agent spawns it once, keeps it alive,
restarts it if it dies, and falls back to Milestone 4A behaviour when it is
missing entirely.

## Planned shape

- Writes one JSON object per line to stdout: app name, title, artist, playback
  status, position, duration, and a base64 thumbnail.
- Reads one command per line on stdin (`play`, `pause`, `next`, `previous`,
  `stop`, `seek <seconds>`).
- Exits cleanly when stdin closes, so it cannot outlive the agent.

Nothing in the agent depends on this being present. `MediaState.backend` reports
`"keys"` when it is absent and `"smtc"` when it is running, and the phone UI
adjusts what it shows accordingly.
