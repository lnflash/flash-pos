import React from 'react';
import {fireEvent, render} from '@testing-library/react-native';

import Settings from '../../../src/components/profile/Settings';

/**
 * The `__DEV__` gate on the Cashu row is the only thing keeping a dead-end row
 * out of release builds: `CashuCardDebug` is registered under `__DEV__` in
 * `src/routes/index.tsx`, so a visible row in a release build navigates into an
 * unhandled `NAVIGATE` action.
 *
 * Jest runs with `__DEV__ === true`, so the false branch is never rendered
 * unless a test flips it deliberately — which is what the second case does.
 */
const devGlobal = global as unknown as {__DEV__: boolean};
const originalDev = devGlobal.__DEV__;

afterEach(() => {
  devGlobal.__DEV__ = originalDev;
});

describe('Settings', () => {
  it('always offers reward settings', () => {
    const onViewRewardSettings = jest.fn();
    const {getByText} = render(
      <Settings onViewRewardSettings={onViewRewardSettings} />,
    );

    fireEvent.press(getByText('Reward Settings'));
    expect(onViewRewardSettings).toHaveBeenCalledTimes(1);
  });

  it('shows event settings only when event mode is on', () => {
    const onViewEventSettings = jest.fn();
    const {queryByText, rerender, getByText} = render(
      <Settings
        onViewRewardSettings={jest.fn()}
        onViewEventSettings={onViewEventSettings}
      />,
    );

    expect(queryByText('Event Settings')).toBeNull();

    rerender(
      <Settings
        onViewRewardSettings={jest.fn()}
        eventModeEnabled
        onViewEventSettings={onViewEventSettings}
      />,
    );

    fireEvent.press(getByText('Event Settings'));
    expect(onViewEventSettings).toHaveBeenCalledTimes(1);
  });
});

describe('Settings — eCash card dev row', () => {
  it('renders the row and fires the handler in a dev build', () => {
    devGlobal.__DEV__ = true;
    const onViewCashuCardDebug = jest.fn();
    const {getByText} = render(
      <Settings
        onViewRewardSettings={jest.fn()}
        onViewCashuCardDebug={onViewCashuCardDebug}
      />,
    );

    fireEvent.press(getByText('eCash card (dev)'));
    expect(onViewCashuCardDebug).toHaveBeenCalledTimes(1);
  });

  // The regression this guards: dropping the `__DEV__` gate ships merchants a
  // row whose destination screen is not registered.
  it('hides the row in a release build even when the handler is passed', () => {
    devGlobal.__DEV__ = false;
    const onViewCashuCardDebug = jest.fn();
    const {queryByText} = render(
      <Settings
        onViewRewardSettings={jest.fn()}
        onViewCashuCardDebug={onViewCashuCardDebug}
      />,
    );

    expect(queryByText('eCash card (dev)')).toBeNull();
    expect(queryByText('Read-only NFC bring-up harness')).toBeNull();
  });

  it('hides the row when no handler is wired', () => {
    devGlobal.__DEV__ = true;
    const {queryByText} = render(<Settings onViewRewardSettings={jest.fn()} />);

    expect(queryByText('eCash card (dev)')).toBeNull();
  });
});

// The charge-animation preview is registered only under __DEV__ (like the
// card harness), so its row carries the same gate.
describe('Settings — charge animation preview row', () => {
  it('renders under __DEV__ and fires its handler', () => {
    devGlobal.__DEV__ = true;
    const onViewChargePreview = jest.fn();
    const {getByText} = render(
      <Settings
        onViewRewardSettings={jest.fn()}
        onViewChargePreview={onViewChargePreview}
      />,
    );

    expect(getByText('Replays the card charge without a card')).toBeTruthy();
    expect(getByText('play-circle-outline')).toBeTruthy();
    fireEvent.press(getByText('Preview charge animation'));
    expect(onViewChargePreview).toHaveBeenCalledTimes(1);
  });

  it('is absent in a release build even when the handler is passed', () => {
    devGlobal.__DEV__ = false;
    const {queryByText} = render(
      <Settings
        onViewRewardSettings={jest.fn()}
        onViewChargePreview={jest.fn()}
      />,
    );

    expect(queryByText('Preview charge animation')).toBeNull();
    expect(queryByText('Replays the card charge without a card')).toBeNull();
  });

  it('is absent when no handler is wired', () => {
    devGlobal.__DEV__ = true;
    const {queryByText} = render(<Settings onViewRewardSettings={jest.fn()} />);

    expect(queryByText('Preview charge animation')).toBeNull();
  });
});
