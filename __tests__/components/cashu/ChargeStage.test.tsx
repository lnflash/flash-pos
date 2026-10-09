import React from 'react';
import {AccessibilityInfo, Animated, ScrollView} from 'react-native';
import {act, render, within} from '@testing-library/react-native';

jest.mock('react-native-svg', () => require('../../../__mocks__/svgStub'));

import ChargeView, {
  type ChargeViewProps,
} from '../../../src/components/cashu/charge/ChargeView';
import {
  INITIAL_STAGE,
  mapPhase,
  type StageState,
} from '../../../src/components/cashu/charge/phaseToStation';
import {
  PLAN_A,
  PLAN_B,
  PLAN_C,
} from '../../../src/components/cashu/charge/previewScript';
import {DUR} from '../../../src/components/cashu/charge/tokens';

const visible = {includeHiddenElements: false} as const;
/** For "must not exist at all": hidden layers count too. */
const all = {includeHiddenElements: true} as const;

let seq = 0;
/** Feeds phases through the same mapper the screen uses. */
function feed(texts: string[], from: StageState = INITIAL_STAGE): StageState {
  return texts.reduce(
    (stage, text) => mapPhase(stage, {text, seq: ++seq}),
    from,
  );
}

const noop = () => {};
const baseProps: ChargeViewProps = {
  amountSat: 12,
  stage: INITIAL_STAGE,
  mode: 'idle',
  flow: 'done',
  plan: PLAN_A,
  pin: '',
  error: null,
  stalled: false,
  nfcSupported: true,
  onBack: noop,
  onCharge: noop,
  onCancel: noop,
  onRetry: noop,
  onPinDigit: noop,
  onPinBackspace: noop,
  onPinClear: noop,
  onPinConfirm: noop,
  reduceMotion: false,
  platform: 'android',
};

function setup(props: Partial<ChargeViewProps> = {}) {
  let current = {...baseProps, ...props};
  const utils = render(<ChargeView {...current} />);
  const update = (next: Partial<ChargeViewProps>) => {
    current = {...current, ...next};
    utils.rerender(<ChargeView {...current} />);
  };
  return {...utils, update};
}

const pillText = (getByTestId: (id: string) => any) =>
  within(getByTestId('phase-raw')).getByText(/./).props.children;

beforeEach(() => {
  jest.useFakeTimers();
});
afterEach(() => {
  jest.clearAllTimers();
  jest.useRealTimers();
  jest.restoreAllMocks();
});

describe('the trust surface', () => {
  it('shows exactly the last emitted phase, and a repeat swaps nothing', () => {
    const {getByTestId, queryByTestId, update} = setup();
    update({mode: 'running'});
    // W0: the verbatim pill is hidden — never a fake phase.
    expect(queryByTestId('phase-raw')).toBeNull();
    expect(getByTestId('phase-title').props.children).toBe(
      'Waiting for the card',
    );

    let stage = feed(['reading card']);
    update({stage});
    expect(pillText(getByTestId)).toBe('reading card');
    expect(getByTestId('phase-title').props.children).toBe('Reading the card');

    const timing = jest.spyOn(Animated, 'timing');
    stage = feed(['reading card'], stage);
    expect(stage.event).toBe('thump');
    update({stage});
    // Same text: no slot swap, no animation at all.
    expect(timing).not.toHaveBeenCalled();
    expect(pillText(getByTestId)).toBe('reading card');

    stage = feed(['verifying PIN', 'burning 16 sat (proof 1/1)'], stage);
    update({stage});
    expect(pillText(getByTestId)).toBe('burning 16 sat (proof 1/1)');
    expect(getByTestId('phase-title').props.children).toBe(
      'Taking 16 sats off the card',
    );
  });

  it('passes an unknown phase through verbatim, title and pill alike', () => {
    const {getByTestId, update} = setup();
    update({
      mode: 'running',
      stage: feed(['reading card', 'polishing the brass']),
    });
    expect(pillText(getByTestId)).toBe('polishing the brass');
    expect(getByTestId('phase-title').props.children).toBe(
      'polishing the brass',
    );
  });
});

describe('the ledger', () => {
  it('reads FROM CARD 16 → PAID 12 + CHANGE 4, pending, before any money moves', () => {
    const {getByTestId} = setup();
    expect(
      within(getByTestId('chip-from')).getAllByText('16').length,
    ).toBeGreaterThan(0);
    expect(
      within(getByTestId('chip-from')).getAllByText('FROM CARD').length,
    ).toBeGreaterThan(0);
    expect(
      within(getByTestId('chip-paid')).getAllByText('12').length,
    ).toBeGreaterThan(0);
    expect(
      within(getByTestId('chip-change')).getAllByText('4').length,
    ).toBeGreaterThan(0);
    expect(within(getByTestId('note-0')).getByText('16')).toBeTruthy();
    expect(within(getByTestId('slip-0')).getByText('4')).toBeTruthy();
  });

  it('draws the exact bill as two chips: FROM CARD → PAID, no change', () => {
    const {getByTestId, queryByTestId} = setup({plan: PLAN_B});
    expect(getByTestId('chip-from')).toBeTruthy();
    expect(
      within(getByTestId('chip-paid')).getAllByText('12').length,
    ).toBeGreaterThan(0);
    expect(queryByTestId('chip-change')).toBeNull();
    expect(queryByTestId('ghost-b')).toBeNull();
    expect(queryByTestId('slip-0')).toBeNull();
    // Stepper: Card, Pay, Settle — no PIN segment, no Change segment.
    expect(getByTestId('segment-card')).toBeTruthy();
    expect(getByTestId('segment-pay')).toBeTruthy();
    expect(getByTestId('segment-settle')).toBeTruthy();
    expect(queryByTestId('segment-pin')).toBeNull();
    expect(queryByTestId('segment-change')).toBeNull();
  });

  it('runs the FROM total for two notes: pending 24, notes 16 and 8, PAID 20 + CHANGE 4', () => {
    const {getByTestId} = setup({plan: PLAN_C, amountSat: 20});
    expect(
      within(getByTestId('chip-from')).getAllByText('24').length,
    ).toBeGreaterThan(0);
    expect(within(getByTestId('note-0')).getByText('16')).toBeTruthy();
    expect(within(getByTestId('note-1')).getByText('8')).toBeTruthy();
    // The odometer rolls 16 → 24.
    expect(getByTestId('odo-0').props.children).toBe('16');
    expect(getByTestId('odo-1').props.children).toBe('24');
    expect(
      within(getByTestId('chip-paid')).getAllByText('20').length,
    ).toBeGreaterThan(0);
    expect(
      within(getByTestId('chip-change')).getAllByText('4').length,
    ).toBeGreaterThan(0);
    expect(within(getByTestId('ghost-a')).getByText('20')).toBeTruthy();
    expect(within(getByTestId('ghost-b')).getByText('4')).toBeTruthy();
  });

  it('stays hidden in the tap flow until a plan exists', () => {
    const {queryByTestId, getByTestId, update} = setup({
      plan: null,
      flow: 'tap',
    });
    expect(queryByTestId('ledger')).toBeNull();
    expect(getByTestId('stepper-single')).toBeTruthy();
    update({plan: PLAN_A});
    expect(getByTestId('ledger')).toBeTruthy();
  });
});

describe('errors', () => {
  it('stops every running gesture, keeps the chip layers and offers a retry', () => {
    const stops: jest.Mock[] = [];
    const realTiming = Animated.timing;
    jest.spyOn(Animated, 'timing').mockImplementation((value, config) => {
      const animation = realTiming(value, config);
      const stop = jest.fn(animation.stop.bind(animation));
      animation.stop = stop;
      stops.push(stop);
      return animation;
    });
    const {getByTestId, getByText, update} = setup();
    update({mode: 'running'});
    const stage = feed([
      'reading card',
      'verifying PIN',
      'burning 16 sat (proof 1/1)',
    ]);
    update({stage});
    const before = stops.length;
    update({mode: 'error', error: '[burning 16 sat (proof 1/1)] tag lost'});
    // The burn's note, its odometer clock, the FROM fill and the lock exit
    // were still in flight: each is stopped where it is (and vetoed).
    expect(
      stops.slice(0, before).filter(stop => stop.mock.calls.length > 0).length,
    ).toBeGreaterThanOrEqual(3);
    expect(getByTestId('chip-from-filled')).toBeTruthy();
    expect(getByTestId('chip-paid')).toBeTruthy();
    expect(getByText('The card moved away', visible)).toBeTruthy();
    expect(
      getByText('Hold the card to the phone again to finish.', visible),
    ).toBeTruthy();
    expect(
      within(getByTestId('error-pill')).getByText(
        '[burning 16 sat (proof 1/1)] tag lost',
      ),
    ).toBeTruthy();
    expect(getByText('Tap card again', visible)).toBeTruthy();
    expect(getByText('Cancel', visible)).toBeTruthy();
  });

  it('names a refusal "Charge didn\'t finish"', () => {
    const {getByText, update} = setup();
    update({mode: 'running', stage: feed(['reading card', 'verifying PIN'])});
    update({mode: 'error', error: '[verifying PIN] wrong PIN'});
    expect(getByText('Charge didn’t finish', visible)).toBeTruthy();
  });

  it('names a full card, before the burn and during the change write (ENG-630)', () => {
    const {getByText, update} = setup();
    update({mode: 'running', stage: feed(['reading card'])});
    update({
      mode: 'error',
      error:
        '[reading card] this card is full: 6 sat of change needs 2 free slots and the card has 0',
    });
    expect(getByText('The card is full', visible)).toBeTruthy();
    expect(
      getByText(
        'Nothing was taken from the card. It has no free slot for the change.',
        visible,
      ),
    ).toBeTruthy();

    const late = setup();
    late.update({
      mode: 'running',
      stage: feed([
        'reading card',
        'verifying PIN',
        'burning 16 sat (proof 1/1)',
        'settling payment and minting change',
        'writing change to card',
      ]),
    });
    late.update({
      mode: 'error',
      error:
        '[writing change to card] LOAD_PROOF failed: card is full — no free slot (0x6A84)',
    });
    expect(late.getByText('The card is full', visible)).toBeTruthy();
    expect(
      late.getByText(
        '12 sats are paid. Your 4 sats change is saved and will be added the next time this card is charged.',
        visible,
      ),
    ).toBeTruthy();
  });
});

describe('reduce motion', () => {
  it('breathes by opacity alone (one ambient loop, no sheen) and mounts no travelling money', () => {
    const timing = jest.spyOn(Animated, 'timing');
    const loop = jest.spyOn(Animated, 'loop');
    const {queryByTestId, update} = setup({reduceMotion: true});
    update({mode: 'running'});
    update({
      stage: feed([
        'reading card',
        'verifying PIN',
        'burning 16 sat (proof 1/1)',
      ]),
    });
    update({
      stage: feed([
        'reading card',
        'verifying PIN',
        'burning 16 sat (proof 1/1)',
        'settling payment and minting change',
      ]),
    });
    update({mode: 'complete'});
    // The ambient clock keeps the active segment and the hold-pill dot
    // breathing (opacity only) so a reduce-motion charge never freezes; the
    // sheen — a moving band — never runs.
    expect(loop).toHaveBeenCalledTimes(1);
    const wrapped = loop.mock.calls[0][0];
    const at = timing.mock.results.findIndex(r => r.value === wrapped);
    expect((timing.mock.calls[at][1] as {duration: number}).duration).toBe(
      DUR.ambient,
    );
    expect(queryByTestId('note-0')).toBeNull();
    expect(queryByTestId('slip-0')).toBeNull();
    expect(queryByTestId('ghost-a')).toBeNull();
    expect(queryByTestId('ghost-b')).toBeNull();
    expect(queryByTestId('chip-from')).toBeTruthy();
  });
});

describe('screen furniture', () => {
  it('has no ScrollView, no "NFC available" row and no duplicate title', () => {
    const {UNSAFE_queryAllByType, queryByText, getByText, update} = setup();
    expect(UNSAFE_queryAllByType(ScrollView)).toHaveLength(0);
    update({mode: 'running', stage: feed(['reading card'])});
    expect(queryByText(/NFC available/, all)).toBeNull();
    expect(queryByText('Charge by eCash card', all)).toBeNull();
    expect(queryByText('Customer pays by tapping their card.', all)).toBeNull();
    expect(getByText('Charge by card')).toBeTruthy();
    expect(getByText('12 sats')).toBeTruthy();
  });

  it('blocks with a notice when the phone cannot read cards', () => {
    const onOpenNfcSettings = jest.fn();
    const {getByText, getByTestId, queryByText} = setup({
      nfcSupported: false,
      onOpenNfcSettings,
    });
    expect(getByTestId('phase-title').props.children).toBe(
      'Card reading is off',
    );
    expect(
      getByText(
        'This phone can’t read cards — turn on NFC in Settings',
        visible,
      ),
    ).toBeTruthy();
    expect(getByText('Open NFC settings', visible)).toBeTruthy();
    expect(queryByText('Tap card to charge', all)).toBeNull();
  });

  it('says what to do with no amount, and disables the charge', () => {
    const {getByTestId, getByText} = setup({amountSat: 0});
    expect(getByTestId('phase-title').props.children).toBe('No amount entered');
    expect(
      getByText('Go back and enter an amount first', visible),
    ).toBeTruthy();
    expect(getByText('—')).toBeTruthy();
  });

  it('shows Cancel while running and never after Paid; hold and lift never together', () => {
    const announce = jest.spyOn(AccessibilityInfo, 'announceForAccessibility');
    const {getByText, queryByText, update} = setup();
    update({mode: 'running', stage: feed(['reading card'])});
    expect(getByText('Cancel', visible)).toBeTruthy();
    expect(getByText('Keep the card on the phone', visible)).toBeTruthy();
    expect(queryByText('Paid — you can lift the card', visible)).toBeNull();
    update({mode: 'complete'});
    expect(queryByText('Cancel', all)).toBeNull();
    expect(getByText('Paid — you can lift the card', visible)).toBeTruthy();
    expect(queryByText('Keep the card on the phone', visible)).toBeNull();
    expect(
      queryByText('Hold the card to the top of the phone', visible),
    ).toBeNull();
    expect(announce).toHaveBeenCalledWith('Paid. You can lift the card.');
  });

  it('starts the finale clock in the same commit that sees complete', () => {
    const timing = jest.spyOn(Animated, 'timing');
    const {update} = setup();
    update({
      mode: 'running',
      stage: feed(['reading card', 'burning 16 sat (proof 1/1)']),
    });
    timing.mockClear();
    act(() => {
      update({mode: 'complete'});
    });
    const finale = timing.mock.calls.find(
      ([, config]) => (config as {duration: number}).duration === 1200,
    );
    expect(finale).toBeTruthy();
    expect(finale![1]).toMatchObject({toValue: 1, useNativeDriver: true});
  });
});

describe('the PIN pose', () => {
  it('shows the sheet over the same stage, then says what happens next at four digits', () => {
    const {getByText, queryByText, update} = setup({flow: 'pin'});
    expect(getByText('Enter the card PIN', visible)).toBeTruthy();
    // The status block and the hold pill are not part of the PIN pose.
    expect(queryByText('Ready to charge', visible)).toBeNull();
    update({pin: '1984'});
    expect(
      getByText('Now hold the card to the phone again', visible),
    ).toBeTruthy();
    update({pin: '19845'});
    expect(getByText('Charge now', visible)).toBeTruthy();
  });

  it('shows a failed attempt in the sheet in the error colour', () => {
    const {getByText, update} = setup({flow: 'pin'});
    update({mode: 'error', error: '[verifying PIN] wrong PIN — 2 tries left'});
    expect(getByText('Wrong PIN — 2 tries left. Try again.')).toBeTruthy();
  });
});
