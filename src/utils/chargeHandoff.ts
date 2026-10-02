import {DUR} from '../components/cashu/charge/tokens';
import {now} from '../components/cashu/charge/motion';

/**
 * The card charge's hand-off to Success, shared by the production screen and
 * the DEV preview's hand-off proof so both take the same path.
 *
 * ONE dispatch: the stack becomes [Home, Success]. Home is the existing route
 * object (same key), so it does not remount; Success swaps in with no
 * animation (routes/index.tsx) on a frame identical to the flood's last one.
 * Never pop() + navigate(): that would flash the keypad in between.
 */

/**
 * ms after complete when the reset goes out: just ahead of the frame from
 * which every finale frame IS Success's first, so Success — whose mount
 * takes longer than the lead — appears on exactly that frame, well inside
 * 1.25 s of complete.
 */
export const HANDOFF_MS = DUR.handoff - DUR.handoffLead;

export interface HandoffNavigation {
  getState?():
    | {routes: ReadonlyArray<{name: string; key?: string}>}
    | undefined;
  reset(state: {index: number; routes: any[]}): void;
}

export function handOffToSuccess(
  navigation: HandoffNavigation,
  params: {title: string; amountText?: string; preview?: boolean},
): void {
  const routes = navigation.getState?.()?.routes ?? [];
  const home = routes.find(r => r.name === 'Home') ?? {name: 'Home'};
  navigation.reset({
    index: 1,
    routes: [home, {name: 'Success', params: {...params, handoff: true}}],
  });
}

/*
 * DEV timing: complete → Success's first frame, logged so the hand-off can
 * be checked against its 1.25 s budget on a device.
 */
let completeAt: number | null = null;

export function markChargeComplete(): void {
  if (__DEV__) {
    completeAt = now();
  }
}

export function logSuccessFirstFrame(): void {
  if (!__DEV__ || completeAt === null) {
    return;
  }
  const at = completeAt;
  completeAt = null;
  requestAnimationFrame(() => {
    console.log(
      `[handoff] Success first frame ${Math.round(
        now() - at,
      )} ms after complete`,
    );
  });
}
