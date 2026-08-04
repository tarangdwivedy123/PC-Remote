# `vendor/` — third-party Windows binaries

One small NirSoft utility does Windows-specific work that Node cannot do on its
own. It is **not committed** to this repo (see `.gitignore`) because it is a
third-party redistributable with its own licence — download it yourself and drop
the `.exe` in this folder.

The agent finds this directory automatically. Override with `PCR_VENDOR_DIR` if
you keep it elsewhere.

| File        | Used for                         | Needed by    |
| ----------- | -------------------------------- | ------------ |
| `nircmd.exe`| Media key emulation, display off | Milestone 4A |

## svcl.exe is no longer required

Volume control was originally going to shell out to NirSoft's `svcl.exe`
(SoundVolumeCommandLine). It no longer does: milestone 3 talks to Windows Core
Audio directly (`IAudioSessionManager2` and friends) through C# interop hosted in
a long-lived PowerShell process.

Nothing needs to be downloaded for volume, including per-application volume.
See "How volume control works" in the root README.

## nircmd.exe

- Download: <https://www.nirsoft.net/utils/nircmd.html>
- Unzip and copy `nircmd.exe` into this folder.

Used for media-key emulation in Milestone 4A and for turning the display off.

## Verifying what you downloaded

It is widely distributed, but you are putting an executable on your machine, so
it is worth a look before you do:

```powershell
# Confirm it is signed by NirSoft
Get-AuthenticodeSignature .\vendor
ircmd.exe | Format-List Status, SignerCertificate

# Record the hash so you can tell if it ever changes
Get-FileHash .\vendor
ircmd.exe -Algorithm SHA256
```

Windows Defender and some other scanners flag NirSoft tools as "riskware"
because the same capabilities are useful to malware. That is a heuristic on the
category of tool, not a detection of anything in this particular binary — but
download it from `nirsoft.net` directly rather than a mirror.

## If they are missing

Nothing crashes. The agent reports the affected feature as unavailable and the
phone UI disables those controls with an explanation, so you can run the rest of
the dashboard without it. Volume does not depend on this folder at all.
