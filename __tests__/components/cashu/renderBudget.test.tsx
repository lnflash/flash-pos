import React from 'react';
import {act, fireEvent, render} from '@testing-library/react-native';

jest.mock('react-native-svg', () => require('../../../__mocks__/svgStub'));

const mockCounts = {card: 0, stage: 0};

// Counting wrappers around the real components: the card hero (memoised,
// mounted once) and the stage (at most one render per phase event).
jest.mock('../../../src/components/cashu/charge/EcashCard', () => {
  const actual = jest.requireActual(
    '../../../src/components/cashu/charge/EcashCard',
  );
  const MockReact = require('react');
  const Inner = actual.default.type;
  const Counted = (props: object) => {
    mockCounts.card += 1;
    return MockReact.createElement(Inner, props);
  };
  return {...actual, __esModule: true, default: MockReact.memo(Counted)};
});
jest.mock('../../../src/components/cashu/charge/ChargeStage', () => {
  const actual = jest.requireActual(
    '../../../src/components/cashu/charge/ChargeStage',
  );
  const MockReact = require('react');
  const Counted = (props: object) => {
    mockCounts.stage += 1;
    return MockReact.createElement(actual.default, props);
  };
  return {...actual, __esModule: true, default: Counted};
});

import ChargeAnimationPreview from '../../../src/screens/ChargeAnimationPreview';
import {
  DEFAULT_SCENARIO,
  SCENARIOS,
} from '../../../src/components/cashu/charge/previewScript';

const svg = require('../../../__mocks__/svgStub');
const CARD_ART = '0 59 320 202';

beforeEach(() => {
  jest.useFakeTimers();
  mockCounts.card = 0;
  mockCounts.stage = 0;
  svg.__resetSvgRenders();
});
afterEach(() => {
  jest.clearAllTimers();
  jest.useRealTimers();
});

describe('render budget', () => {
  it('draws the card once and renders the stage at most once per script step', () => {
    const {unmount} = render(<ChargeAnimationPreview />);
    expect(mockCounts.card).toBe(1);
    const perStep: Array<[number, string, number]> = [];
    let at = 0;
    const times = [...new Set(DEFAULT_SCENARIO.steps.map(step => step.t))];
    for (const t of times) {
      const before = mockCounts.stage;
      act(() => {
        jest.advanceTimersByTime(t - at + 160);
      });
      at = t + 160;
      const kinds = DEFAULT_SCENARIO.steps
        .filter(step => step.t === t)
        .map(step => step.kind)
        .join('+');
      perStep.push([t, kinds, mockCounts.stage - before]);
    }
    perStep.forEach(([t, kinds, renders]) => {
      expect([t, kinds, renders <= 1]).toEqual([t, kinds, true]);
    });
    // The hold and end steps change nothing, so nothing renders.
    expect(perStep.find(([t]) => t === 8400)![2]).toBe(0);
    // One loop of the whole script, finale and reset included: the card
    // hero and its vector art were drawn exactly once.
    expect(mockCounts.card).toBe(1);
    expect(svg.__svgRenders[CARD_ART]).toBe(1);
    unmount();
  });

  it('renders nothing for a repeated identical phase (five reads in a row)', () => {
    const {getByTestId} = render(<ChargeAnimationPreview />);
    fireEvent.press(getByTestId('scenario-full'));
    act(() => {
      jest.advanceTimersByTime(1700);
    });
    const before = mockCounts.stage;
    act(() => {
      jest.advanceTimersByTime(2180 - 1700);
    });
    // 1820, 1940, 2060, 2180: four repeats of 'reading card'.
    expect(mockCounts.stage - before).toBe(0);
  });

  it('keeps the card art to one draw per mount across every scenario', () => {
    for (const scenario of SCENARIOS) {
      svg.__resetSvgRenders();
      const {getByTestId, unmount} = render(<ChargeAnimationPreview />);
      fireEvent.press(getByTestId(`scenario-${scenario.id}`));
      act(() => {
        jest.advanceTimersByTime(scenario.durationMs + 200);
      });
      expect([scenario.id, svg.__svgRenders[CARD_ART]]).toEqual([
        scenario.id,
        1,
      ]);
      unmount();
      jest.clearAllTimers();
    }
  });
});
