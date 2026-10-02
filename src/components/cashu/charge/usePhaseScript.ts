import {useEffect, useRef} from 'react';

import type {Scenario, ScriptStep} from './previewScript';

export interface PhaseScriptOptions {
  /** 0.5 plays at half speed. */
  speed?: number;
  loop?: boolean;
  active?: boolean;
  /**
   * A new value restarts the script from t = 0 — the preview bumps it on
   * every scenario pick, so re-picking the playing scenario restarts the
   * script together with the stage (field-found: the stage reset to idle
   * while the old script ran on and played the finale over "Ready to charge").
   */
  runKey?: number;
  onStep: (step: ScriptStep) => void;
}

/**
 * Plays a preview scenario: every step is scheduled from ONE start timestamp
 * (t0 + step.t / speed), so steps never drift; a late timer fires every
 * overdue step in order. A loop continues from t0 += duration / speed. One
 * pending timer at a time, cleared on unmount or when anything changes.
 */
export function usePhaseScript(
  scenario: Scenario,
  {
    speed = 1,
    loop = true,
    active = true,
    runKey = 0,
    onStep,
  }: PhaseScriptOptions,
): void {
  const onStepRef = useRef(onStep);
  onStepRef.current = onStep;

  useEffect(() => {
    if (!active) {
      return;
    }
    const steps = scenario.steps;
    let t0 = Date.now();
    let index = 0;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let stopped = false;

    const due = (step: ScriptStep) => t0 + step.t / speed;

    const run = () => {
      timer = null;
      while (!stopped) {
        if (index >= steps.length) {
          if (!loop) {
            stopped = true;
            return;
          }
          t0 += scenario.durationMs / speed;
          index = 0;
          continue;
        }
        const step = steps[index];
        const wait = due(step) - Date.now();
        if (wait > 0) {
          timer = setTimeout(run, wait);
          return;
        }
        index += 1;
        onStepRef.current(step);
      }
    };

    run();
    return () => {
      stopped = true;
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
    };
  }, [scenario, speed, loop, active, runKey]);
}
