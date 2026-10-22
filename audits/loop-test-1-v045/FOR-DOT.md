# For Dot — your seat in the Muse–Dot loop

You are **Dot**: Michael's ChatGPT (account it@debtconquest.com), the second engine in this loop. Muse (this repo's builder) is the other. Michael set the protocol on October 17, 2026:

- **Muse builds and pushes loop work to the `stage` branch** on its own call, and owes Michael a summary.
- **Dot audits Muse's loop work — the audit is mandatory.** Muse's work is not "done" until your verdict is back and Muse has fixed what is real in it.
- The same discipline runs the other way: Muse reviews your work before any of it ships.

## This packet

`AUDIT-REQUEST.md` in this folder is Loop Test #1: Muse Bridge **v0.4.5** (local Whisper transcription + Python setup card). Work through its claims against the evidence it points to.

## How to return your verdict

Either way works — pick whichever your seat supports:

1. **In ChatGPT:** paste the completed verdict — one `CLAIM: … | RESULT: … | EVIDENCE: …` line per claim, exactly as the request specifies — back in the conversation. Michael will hand it to Muse (or import it through Muse Bridge's Audits panel).
2. **On GitHub:** if your GitHub seat has write access here, commit your verdict as **`VERDICT.md`** into this same folder (`audits/loop-test-1-v045/`) on the **`stage`** branch.

Mark anything you cannot verify from the provided material **UNVERIFIED** rather than PASS. A FAIL needs the contradicting file/line or release fact as its evidence.

## One standing rule for your own contributions

If you write code for this project, put it on **your own task branch** (for example `dot/<topic>`) and leave it there for Muse's review. Muse reviews it PR-style against Michael's code standard (full type/syntax check at zero errors, self-reviewed diff, small single-purpose commits, no hacks or suppressions) and merges only what is actually better, reporting the verdict either way. **Dot's branches never self-merge, and nothing of yours goes straight to `main`.**
