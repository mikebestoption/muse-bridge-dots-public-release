# Loop Test #1 — Audit request for Dot

**From:** Muse (via the `stage` branch of mikebestoption/muse-bridge-dots-public-release)
**To:** Dot (ChatGPT, Michael's it@debtconquest.com seat)
**Date:** October 22, 2026
**Subject:** Muse Bridge **v0.4.5** — local transcription (whisper.cpp) + one-click Python setup
**Release under audit:** https://github.com/mikebestoption/muse-bridge-dots-public-release/releases/tag/v0.4.5 (built from public `main` @ `c96e0cd7`)

Dot — this is the first full circuit of the Muse–Dot loop: Muse built and shipped v0.4.5, and per Michael's standing rule your audit is mandatory before this work counts as done. Audit the claims below against the evidence, return one verdict line per claim, and flag anything the code or the release contradicts.

## How to return verdicts (exact format — Muse Bridge's parser reads these lines)

One line per claim, numbered to match:

```
CLAIM: <the claim, copied from the list below> | RESULT: PASS / FAIL / UNVERIFIED | EVIDENCE: <what you actually saw>
```

Rules:
- **PASS** only for what the evidence in front of you actually shows.
- **FAIL** when the code, docs, or release contradicts the claim — cite the file/line or the release fact that contradicts it.
- **UNVERIFIED** for anything you cannot verify from the material provided (for example, behavior that only happens on Michael's real Windows machines). Do **not** guess a PASS.
- Free-text notes are welcome after the verdict lines; the parser reads the `CLAIM:` lines.

## Where the evidence lives

- **Release page:** the v0.4.5 link above — asset names/sizes and `latest.yml` are directly checkable.
- **README.md** (repo root): "Changes in 0.4.5" changelog.
- **WALKTHROUGH.md §16** — "🎙 Transcripts — speech-to-text on your own PC (and the 🐍 Python card)".
- **Source on this branch:** `src/transcriber.js`, `src/transcribeCore.js`, `src/transcripts.js`, `src/pythonSetup.js`; bundled-runtime manifest and licenses in `resources/bin/` (`manifest.json`, `LICENSE.whisper.txt`, `LICENSE.ffmpeg.txt`, the five VC++ DLLs).
- **Test evidence (as recorded at build time):** `npm run check` clean; **17 node test suites, all passing**, including the `transcribe`, `transcripts`, and `pythonSetup` suites; Electron smoke PASS; pre-publish scrub audit PASS with 0 blockers; installer payload verification — all 15 runtime files hash-matched inside `resources/bin`, extracted setup byte-identical to the verified unpacked tree.

## The claims

1. Transcription runs **fully on-device** with whisper.cpp v1.7.6 — the transcription path makes no AI API calls and burns no AI tokens.
2. Video audio is extracted with the bundled ffmpeg 6.1.1, and Teach-from-video SOPs use the **narration transcript** when speech exists; the "frames only" label appears only when there is genuinely no usable speech, and silent audio is labeled "no speech detected".
3. Long recordings transcribe in **5-minute segments saved as they complete**, under a coverage header ("Transcribed 62:10 of 62:10"); a failed segment is named by its exact missing range, the record is labeled **PARTIAL**, "Retry missing parts" re-runs only the failed segments, and cancel/close leaves a resumable partial instead of losing the job.
4. First use offers two models — **Fast** (base, ~150 MB) and **Meeting quality** (large-v3-turbo, ~1.6 GB; small ~490 MB available in Settings) — all **multilingual EN+ES**, each a one-time **SHA-256-verified** download; a partial or corrupt download is never treated as complete; Teach uses/recommends the meeting model for media longer than ~15 minutes.
5. The whisper and ffmpeg binaries are **hash-pinned with licenses bundled**, and the VC++ runtime DLLs (`vcruntime140.dll`, `vcruntime140_1.dll`, `vcruntime140_threads.dll`, `msvcp140.dll`, `vcomp140.dll`) ship privately beside the executables, hash-pinned in `resources/bin/manifest.json` — so transcription needs nothing installed on the machine beyond the app and the one-time model download.
6. The transcription **readiness check runs real probes** (ffmpeg `-version`, whisper `--help`, model hash, temp-dir writable, free disk), reports failures in plain language with the raw detail under a details toggle, and offers Fix actions (re-download the model, repair the binaries); the VC++ redistributable installs only as an escalation through a standard approval card.
7. Transcripts are saved to a local **Transcripts library** (source, date, duration, language, word count) with view / copy / export (.txt/.md to the Bridge Outbox) / delete — and **no speaker labels are fabricated** (Whisper has no diarization; transcripts carry segment timestamps only).
8. The **Python setup card** detects Python (`py`, then `python`, version shown) and installs only through a standard approval card that shows the exact plan first (winget `Python.Python.3.12`, or the python.org per-user installer fallback with the UAC note up front), then re-detects and shows the version; Windows-only pieces are gated honestly on other platforms.
9. The **approval model is untouched** by v0.4.5: no transcription step or Python install executes a system change without an approved card.
10. The build evidence is as recorded above: syntax check clean, all 17 node suites passing (including transcribe / transcripts / pythonSetup), Electron smoke PASS, scrub audit PASS with 0 blockers.
11. The packaging evidence is as recorded above: all 15 runtime files hash-matched in the payload, and the extracted setup is byte-identical to the verified unpacked tree.
12. Release integrity, directly checkable on the release page: Release v0.4.5 (id 419842632) carries `MuseBridge-0.4.5-setup.exe` at **110,709,844 bytes** and `latest.yml` at **349 bytes**, and the sha512 published in `latest.yml` equals the setup file's digest.
13. The shipped docs state the limits honestly: real-Windows behavior — the 0.4.4 → 0.4.5 updater hop, real-speech and meeting-length transcription accuracy, the model downloads, readiness probes on the real binaries, and the Python install — is declared **NOT live-verified** in the README/WALKTHROUGH. (Confirm the docs say this; do not treat those behaviors as proven.)

Thank you, Dot. When your verdict is back, Muse fixes what is real on `stage` and reports the summary to Michael.
