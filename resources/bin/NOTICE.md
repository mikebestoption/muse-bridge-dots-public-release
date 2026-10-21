# Bundled runtime binaries — local transcription (v0.4.5)

Muse Bridge transcribes audio and video **locally, on this PC** — no
cloud service, no API tokens, nothing uploaded. To make that work on a
clean Windows machine with **zero extra installs**, the app ships these
third-party binaries in this folder (see `manifest.json` for the pinned
versions, source URLs and SHA-256 of every file):

- `whisper-cli.exe` + `whisper.dll` + `ggml*.dll` — whisper.cpp v1.7.6
  (MIT license, `LICENSE.whisper.txt`). The speech-to-text engine.
- `ffmpeg.exe` — FFmpeg 6.1.1 static build (GPLv3, `LICENSE.ffmpeg.txt`),
  used ONLY to pull the audio track out of media files and convert it
  to the 16 kHz mono WAV whisper.cpp reads.
- `vcruntime140.dll`, `vcruntime140_1.dll`, `vcruntime140_threads.dll`,
  `msvcp140.dll`, `vcomp140.dll` — the official Microsoft Visual C++
  v14 runtime DLLs (x64), extracted from Microsoft's own
  `vc_redist.x64.exe`. They sit next to the whisper executables so
  Windows loads them **privately** — this is what prevents the classic
  "MSVCP140.dll was not found" / "VCRUNTIME140.dll was not found"
  failures without any system-wide install and without admin rights.

The executables are not stored in git (size); `scripts/fetch-binaries.js`
downloads them from the pinned URLs in `manifest.json` and verifies
every hash before packaging. The Microsoft DLLs are small and are kept
in git, so they can never go missing from a build.

Transcription needs **nothing else** — no Python, no pip, no other
installer, no internet — after the one-time speech-model download
(~150 MB for Fast, ~1.6 GB for Meeting quality), which the app fetches
into its own data folder and hash-verifies before first use.
