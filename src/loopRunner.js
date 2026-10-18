'use strict';

// Loop runner (Muse Bridge v0.4.0) — executes a Loop's steps in order.
//
// Environment-agnostic (UMD: window.MuseLoopRunner in the renderer,
// module.exports under node) with every side effect injected, so the
// approval-gating behavior is unit-testable with fakes:
//
//   deps.chat(prompt)            -> { text, actions? }   (prompt steps)
//   deps.requestApproval(action) -> boolean              (task/fill steps,
//                                   interactive mode: the standard card)
//   deps.executeTask(action, { mode }) -> task-engine result
//   deps.waitInstruction(step)   -> 'done' | 'skip' | 'stop' | 'park'
//   deps.onEvent(evt)            -> UI updates (step/run/halt events)
//   deps.mode                    -> 'interactive' (default) | 'queue'
//
// THE APPROVAL MODEL IS UNCHANGED: in interactive mode a task/fill
// step executes ONLY after requestApproval resolves true for that
// exact action — the runner has no path around it. In queue mode the
// renderer passes a requestApproval that reflects the one Night Queue
// approval (the queue list named this loop), and main's own queue-mode
// guards still apply inside executeTask.
//
// Halt semantics: a denied approval or a failed step HALTS the run and
// waits for decide('skip' | 'stop') — skip marks nothing extra, the
// step keeps its denied/failed status and the run continues with the
// next step; stop ends the run. An execution that reports waitForUser
// (locked vault, locked session, wait_for_user action) ends the run as
// 'waiting_on_user' with the reason — the Night Queue parks the job,
// interactively Michael just handles it and re-runs.
// A prompt step's reply is NEVER executed: if it proposes desktop
// actions, they are noted in the log and ignored — inside a Loop, only
// task/fill steps run actions, each through its own approval.

(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
  if (root) {
    root.MuseLoopRunner = api;
  }
})(typeof window !== 'undefined' ? window : null, function () {
  const core = typeof module !== 'undefined' && module.exports
    ? require('./loopsCore')
    : window.MuseLoopsCore;

  const defaultSleep = (ms) => new Promise((r) => setTimeout(r, ms));

  function createLoopRunner({ loop, deps }) {
    if (!loop || !Array.isArray(loop.steps)) throw new Error('createLoopRunner needs a loop with steps.');
    if (!deps || typeof deps.executeTask !== 'function') throw new Error('createLoopRunner needs deps.executeTask.');
    const sleep = typeof deps.sleep === 'function' ? deps.sleep : defaultSleep;
    const mode = deps.mode === 'queue' ? 'queue' : 'interactive';
    const onEvent = typeof deps.onEvent === 'function' ? deps.onEvent : () => {};

    const stepStates = loop.steps.map((step) => ({
      id: step.id, type: step.type, status: 'pending', output: ''
    }));

    let runStatus = 'idle'; // idle|running|paused|halted|done|failed|stopped|waiting_on_user
    let stopRequested = false;
    let pauseRequested = false;
    let haltGate = null; // { resolve } while halted awaiting decide()
    let startPromise = null;
    let lastOutput = '';

    function emit(evt) {
      try { onEvent(evt); } catch (_) { /* a broken UI listener must not break a run */ }
    }
    function emitStep(index) {
      emit({ type: 'step', index, status: stepStates[index].status, output: stepStates[index].output });
    }
    function emitRun(extra) {
      emit({ type: 'run', status: runStatus, ...extra });
    }

    async function waitWhilePaused() {
      while (pauseRequested && !stopRequested) {
        runStatus = 'paused';
        emitRun({});
        // eslint-disable-next-line no-await-in-loop
        await sleep(200);
      }
      if (runStatus === 'paused') {
        runStatus = 'running';
        emitRun({});
      }
    }

    // Park the run on a denied/failed step until the user decides.
    // Returns 'skip' or 'stop'.
    function waitForDecision(index, reason) {
      runStatus = 'halted';
      emit({ type: 'halted', index, reason, status: stepStates[index].status });
      emitRun({ haltedIndex: index, reason });
      if (stopRequested) return Promise.resolve('stop');
      return new Promise((resolve) => { haltGate = { resolve }; });
    }

    function finish(status, reason) {
      runStatus = status;
      emitRun({ reason: reason || '' });
      return {
        status,
        reason: reason || '',
        loopName: loop.name,
        steps: stepStates.map((s) => ({ ...s })),
        lastOutput
      };
    }

    async function run() {
      runStatus = 'running';
      emitRun({});
      for (let i = 0; i < loop.steps.length; i++) {
        // eslint-disable-next-line no-await-in-loop
        await waitWhilePaused();
        if (stopRequested) return finish('stopped', 'Stopped by you.');
        const step = loop.steps[i];
        const state = stepStates[i];
        state.status = 'running';
        emitStep(i);

        try {
          if (step.type === 'note') {
            state.output = step.text || '';
            state.status = 'done';
          } else if (step.type === 'prompt') {
            if (typeof deps.chat !== 'function') throw new Error('Prompt steps need a chat channel.');
            const promptText = core.applyPrev(step.text, lastOutput);
            // eslint-disable-next-line no-await-in-loop
            const res = await deps.chat(promptText);
            state.output = res && typeof res.text === 'string' ? res.text : '';
            if (res && Array.isArray(res.actions) && res.actions.length) {
              state.output += '\n[The reply proposed desktop steps — not run inside a Loop. Only task/fill steps run actions, each through its approval.]';
            }
            lastOutput = state.output;
            state.status = 'done';
          } else if (step.type === 'instruction') {
            if (typeof deps.waitInstruction !== 'function') throw new Error('Manual steps need a waitInstruction channel.');
            // eslint-disable-next-line no-await-in-loop
            const verdict = await deps.waitInstruction(step);
            if (stopRequested || verdict === 'stop') {
              state.status = 'skipped';
              state.output = 'Stopped here by you.';
              emitStep(i);
              return finish('stopped', 'Stopped by you at a manual step.');
            }
            if (verdict === 'park') {
              state.status = 'waiting_on_user';
              state.output = step.text || 'Manual step needs you.';
              emitStep(i);
              return finish('waiting_on_user', step.text || 'Manual step needs you.');
            }
            if (verdict === 'skip') {
              state.status = 'skipped';
              state.output = 'Skipped by you.';
            } else {
              state.status = 'done';
              state.output = 'Done — marked complete by you.';
            }
          } else if (step.type === 'task' || step.type === 'fill') {
            const action = core.stepToAction(step, loop.name);
            let approved = true;
            if (typeof deps.requestApproval === 'function') {
              // eslint-disable-next-line no-await-in-loop
              approved = await deps.requestApproval(action);
            }
            if (stopRequested) {
              state.status = 'skipped';
              state.output = 'Stopped before this step ran — nothing was executed.';
              emitStep(i);
              return finish('stopped', 'Stopped by you.');
            }
            if (!approved) {
              state.status = 'denied';
              state.output = 'Denied — nothing was run.';
              emitStep(i);
              // eslint-disable-next-line no-await-in-loop
              const decision = await waitForDecision(i, 'Approval denied for this step.');
              if (decision === 'stop' || stopRequested) return finish('stopped', 'Stopped after a denied step.');
              continue; // skip: step keeps 'denied', run moves on
            }
            // eslint-disable-next-line no-await-in-loop
            const res = await deps.executeTask(action, { mode });
            if (res && res.waitForUser) {
              state.status = 'waiting_on_user';
              state.output = res.output || 'Waiting on you.';
              emitStep(i);
              return finish('waiting_on_user', res.parkReason || res.output || 'Waiting on you.');
            }
            if (res && res.cancelled) {
              state.status = 'skipped';
              state.output = res.output || 'Cancelled — nothing was typed.';
              emitStep(i);
              return finish('stopped', 'Cancelled during the hands guard — nothing was typed.');
            }
            if (!res || !res.ok) {
              state.status = 'failed';
              state.output = res ? res.output || 'Step failed.' : 'Step failed.';
              emitStep(i);
              // eslint-disable-next-line no-await-in-loop
              const decision = await waitForDecision(i, state.output);
              if (decision === 'stop' || stopRequested) return finish('stopped', 'Stopped after a failed step.');
              continue;
            }
            state.output = res.output || '';
            lastOutput = state.output;
            state.status = 'done';
          } else {
            state.status = 'skipped';
            state.output = `Unknown step type "${step.type}" — skipped.`;
          }
        } catch (err) {
          state.status = 'failed';
          state.output = `Error: ${err.message}`;
          emitStep(i);
          // eslint-disable-next-line no-await-in-loop
          const decision = await waitForDecision(i, state.output);
          if (decision === 'stop' || stopRequested) return finish('stopped', 'Stopped after a failed step.');
          continue;
        }
        emitStep(i);
      }
      const anyFailed = stepStates.some((s) => s.status === 'failed' || s.status === 'denied');
      return finish(anyFailed ? 'failed' : 'done', anyFailed ? 'Finished with failed/denied steps (skipped past).' : '');
    }

    return {
      start() {
        if (!startPromise) startPromise = run();
        return startPromise;
      },
      stop() {
        stopRequested = true;
        pauseRequested = false;
        if (haltGate) {
          const gate = haltGate;
          haltGate = null;
          gate.resolve('stop');
        }
      },
      pause() {
        if (runStatus === 'running') pauseRequested = true;
      },
      resume() {
        pauseRequested = false;
      },
      // Answer a halt: 'skip' continues with the next step, 'stop' ends.
      decide(decision) {
        if (!haltGate) return false;
        const gate = haltGate;
        haltGate = null;
        runStatus = 'running';
        gate.resolve(decision === 'skip' ? 'skip' : 'stop');
        return true;
      },
      getState() {
        return {
          status: runStatus,
          steps: stepStates.map((s) => ({ ...s })),
          lastOutput
        };
      }
    };
  }

  return { createLoopRunner };
});
