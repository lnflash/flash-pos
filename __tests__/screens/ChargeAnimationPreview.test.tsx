import React from 'react';
import {act, fireEvent, render, within} from '@testing-library/react-native';
import {NavigationContext} from '@react-navigation/native';

// The preview must run with no card, NFC, mint, store or navigation to
// Success: every service module throws the moment anything requires it.
jest.mock('../../src/services/cashuCardNfc', () => {
  throw new Error('the charge preview must not touch cashuCardNfc');
});
jest.mock('../../src/services/cashuCharge', () => {
  throw new Error('the charge preview must not touch cashuCharge');
});
jest.mock('../../src/services/cashuAutoSettle', () => {
  throw new Error('the charge preview must not touch cashuAutoSettle');
});
jest.mock('../../src/store/hooks', () => {
  throw new Error('the charge preview must not touch the store');
});
// Same barrel stubs as the other screen tests; the preview imports leaves.
jest.mock('../../src/components', () => {
  throw new Error('the charge preview must import leaf components only');
});
jest.mock('../../src/hooks', () => {
  throw new Error('the charge preview must not use the app hooks');
});
jest.mock('react-native-svg', () => require('../../__mocks__/svgStub'));

import ChargeAnimationPreview, {
  previewReducer,
} from '../../src/screens/ChargeAnimationPreview';
import {SCENARIOS} from '../../src/components/cashu/charge/previewScript';

const visible = {includeHiddenElements: false} as const;

type Listener = () => void;

function fakeNavigation() {
  const listeners: Record<string, Listener[]> = {focus: [], blur: []};
  let focused = true;
  return {
    navigation: {
      isFocused: () => focused,
      addListener: (event: string, fn: Listener) => {
        listeners[event].push(fn);
        return () => {
          listeners[event] = listeners[event].filter(l => l !== fn);
        };
      },
      goBack: jest.fn(),
      navigate: jest.fn(),
      reset: jest.fn(),
      dispatch: jest.fn(),
    },
    blur: () => {
      focused = false;
      listeners.blur.forEach(fn => fn());
    },
  };
}

const renderPreview = () => {
  const nav = fakeNavigation();
  const utils = render(
    <NavigationContext.Provider value={nav.navigation as never}>
      <ChargeAnimationPreview />
    </NavigationContext.Provider>,
  );
  return {...utils, ...nav};
};

beforeEach(() => {
  jest.useFakeTimers();
});
afterEach(() => {
  jest.clearAllTimers();
  jest.useRealTimers();
});

/** Advances the script clock to `t` ms after the start. */
const advanceTo = (() => {
  let at = 0;
  const fn = (t: number) => {
    act(() => {
      jest.advanceTimersByTime(t - at);
    });
    at = t;
  };
  fn.reset = () => {
    at = 0;
  };
  return fn;
})();

beforeEach(() => advanceTo.reset());

describe('ChargeAnimationPreview', () => {
  it('plays the default scenario through the production ChargeView', () => {
    const {getByTestId, getByText, queryByText, navigation} = renderPreview();
    const title = () => getByTestId('phase-title').props.children;
    const raw = () =>
      within(getByTestId('phase-raw')).getByText(/./).props.children;

    expect(title()).toBe('Ready to charge');
    expect(getByText('12 sats')).toBeTruthy();
    expect(getByText('Tap card to charge', visible)).toBeTruthy();

    advanceTo(1000);
    expect(title()).toBe('Waiting for the card');
    expect(
      getByText('Hold the card to the top of the phone', visible),
    ).toBeTruthy();
    expect(getByText('Cancel', visible)).toBeTruthy();

    const beats: Array<[number, string, string]> = [
      [1700, 'Reading the card', 'reading card'],
      [2000, 'Checking the PIN', 'verifying PIN'],
      [2400, 'Taking 16 sats off the card', 'burning 16 sat (proof 1/1)'],
      [3600, 'Settling with the mint', 'settling payment and minting change'],
      [6100, 'Putting 4 sats on the card', 'writing change to card'],
      [6900, 'Checking the card', 'reading card'],
    ];
    for (const [t, friendly, phase] of beats) {
      advanceTo(t);
      expect(title()).toBe(friendly);
      expect(raw()).toBe(phase);
      expect(getByText('Keep the card on the phone', visible)).toBeTruthy();
    }

    advanceTo(7200);
    expect(getByText('Paid — you can lift the card', visible)).toBeTruthy();
    expect(queryByText('Cancel', visible)).toBeNull();
    expect(queryByText('Keep the card on the phone', visible)).toBeNull();

    advanceTo(9400);
    expect(title()).toBe('Ready to charge');

    // ...and around again.
    advanceTo(9700 + 1700);
    expect(title()).toBe('Reading the card');
    expect(navigation.navigate).not.toHaveBeenCalled();
    expect(navigation.reset).not.toHaveBeenCalled();
    expect(navigation.dispatch).not.toHaveBeenCalled();
  });

  it('re-picking the playing scenario restarts the script with the stage: no finale from idle', () => {
    const {getByTestId, queryByText} = renderPreview();
    advanceTo(4000); // settling
    fireEvent.press(getByTestId('scenario-pin'));
    // The old script would complete at 7200; the restarted one is still
    // taking the 16 at 3300 ms into its own run.
    advanceTo(7300);
    expect(queryByText('Paid — you can lift the card', visible)).toBeNull();
    expect(getByTestId('phase-title').props.children).toBe(
      'Taking 16 sats off the card',
    );
    advanceTo(4000 + 7200 + 10);
    expect(queryByText('Paid — you can lift the card', visible)).toBeTruthy();
  });

  it('shows the error state, then loops back', () => {
    const {getByText, getByTestId, queryByText} = renderPreview();
    fireEvent.press(getByTestId('scenario-error'));
    advanceTo(6500);
    expect(getByText('The card moved away', visible)).toBeTruthy();
    // Where the money is, in plain words: paid, change recorded for the
    // card's next tap (ENG-630).
    expect(
      getByText(
        '12 sats are paid. Your 4 sats change is saved and will be added the next time this card is charged.',
        visible,
      ),
    ).toBeTruthy();
    expect(
      within(getByTestId('error-pill')).getByText(
        '[writing change to card] Tag was lost.',
      ),
    ).toBeTruthy();
    expect(getByText('Tap card again', visible)).toBeTruthy();
    expect(getByText('Cancel', visible)).toBeTruthy();
    // The reset fades through white (75 ms out, swap, 75 ms in).
    advanceTo(9100);
    expect(queryByText('Tap card again', visible)).toBeNull();
    expect(getByTestId('phase-title').props.children).toBe('Ready to charge');
  });

  it('lands a reset that is still fading BEFORE any later step, even when a stalled JS thread delivers them together', () => {
    const {getByTestId, queryByText} = renderPreview();
    fireEvent.press(getByTestId('scenario-error'));
    advanceTo(8990);
    expect(queryByText('The card moved away', visible)).toBeTruthy();
    // A 1.4 s stall: the reset (9000), the loop's idle (9300) and its
    // running (10300) all come due in one go.
    act(() => {
      jest.setSystemTime(Date.now() + 1400);
      jest.advanceTimersByTime(1);
    });
    act(() => {
      jest.advanceTimersByTime(200);
    });
    // The new charge is running — not stuck at idle under a late reset.
    expect(getByTestId('phase-title').props.children).toBe(
      'Waiting for the card',
    );
    expect(queryByText('The card moved away', visible)).toBeNull();
  });

  it('plays every scenario to its end without touching a service', () => {
    for (const scenario of SCENARIOS) {
      advanceTo.reset();
      const {getByTestId, unmount} = renderPreview();
      fireEvent.press(getByTestId(`scenario-${scenario.id}`));
      advanceTo(scenario.durationMs + 10);
      expect(getByTestId('phase-title')).toBeTruthy();
      unmount();
      jest.clearAllTimers();
    }
  });

  it('walks the full flow through the PIN sheet', () => {
    const {getByTestId, getByText, queryByText} = renderPreview();
    fireEvent.press(getByTestId('scenario-full'));
    advanceTo(2180);
    expect(getByTestId('phase-title').props.children).toBe('Reading the card');
    advanceTo(2400);
    expect(getByText('Enter the card PIN', visible)).toBeTruthy();
    advanceTo(4060);
    expect(
      getByText('Now hold the card to the phone again', visible),
    ).toBeTruthy();
    advanceTo(4760);
    expect(queryByText('Enter the card PIN', visible)).toBeNull();
    expect(getByTestId('phase-title').props.children).toBe(
      'Waiting for the card',
    );
    advanceTo(6400);
    expect(getByTestId('phase-title').props.children).toBe(
      'Taking 16 sats off the card',
    );
  });

  it('hides the dev bar for clean recordings and brings it back on a header long-press', () => {
    const {getByTestId, queryByTestId, getByText} = renderPreview();
    fireEvent.press(getByTestId('preview-hide'));
    expect(queryByTestId('preview-bar')).toBeNull();
    fireEvent(getByText('Charge by card'), 'longPress');
    expect(getByTestId('preview-bar')).toBeTruthy();
  });

  it('stops every timer on unmount', () => {
    const {unmount} = renderPreview();
    advanceTo(2400);
    unmount();
    // The edge-tint watchdog is the only timer allowed to outlive the screen
    // (it only ever hides the tint), and the preview never showed the tint.
    jest.runOnlyPendingTimers();
    expect(jest.getTimerCount()).toBe(0);
  });

  it('parks at idle on blur', () => {
    const {getByTestId, blur} = renderPreview();
    advanceTo(2400);
    expect(getByTestId('phase-title').props.children).toBe(
      'Taking 16 sats off the card',
    );
    act(() => blur());
    expect(getByTestId('phase-title').props.children).toBe('Ready to charge');
    advanceTo(20000);
    expect(getByTestId('phase-title').props.children).toBe('Ready to charge');
  });
});

describe('previewReducer', () => {
  const base = previewReducer({resetKey: 0} as never, {
    type: 'scenario',
    scenario: SCENARIOS[0],
  });

  it('ignores a phase, a completion or an error unless a charge is running', () => {
    // Field-found: with JS load on, a stage that missed "running" played the
    // finale over "Ready to charge". A phase means something only mid-charge.
    expect(base.mode).toBe('idle');
    for (const step of [
      {t: 0, kind: 'phase', text: 'reading card'},
      {t: 0, kind: 'complete'},
      {t: 0, kind: 'error', message: 'x'},
    ] as const) {
      expect(previewReducer(base, {type: 'step', step})).toBe(base);
    }
    const running = previewReducer(base, {
      type: 'step',
      step: {t: 0, kind: 'mode', mode: 'running'},
    });
    const read = previewReducer(running, {
      type: 'step',
      step: {t: 0, kind: 'phase', text: 'reading card'},
    });
    expect(read.stage.phase).toBe('reading card');
    expect(
      previewReducer(read, {type: 'step', step: {t: 0, kind: 'complete'}}).mode,
    ).toBe('complete');
  });
});
