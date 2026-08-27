import React from 'react';
import {fireEvent, render} from '@testing-library/react-native';
import {Provider} from 'react-redux';
import {configureStore} from '@reduxjs/toolkit';
import Profile from '../../src/screens/Profile';
import rootReducer from '../../src/store/reducers';

const mockNavigate = jest.fn();
const mockReplace = jest.fn();
const mockIsRewardsEnabled = jest.fn();

jest.mock('@react-navigation/native', () => ({
  useNavigation: () => ({
    navigate: mockNavigate,
    replace: mockReplace,
  }),
}));

jest.mock('../../src/utils/featureFlags', () => ({
  isRewardsEnabled: () => mockIsRewardsEnabled(),
}));

jest.mock('../../src/components/profile', () => {
  const MockReact = require('react');
  const {Text, TouchableOpacity} = require('react-native');

  return {
    Account: () => MockReact.createElement(Text, null, 'Account'),
    // Every callback Profile wires must be reachable from the stub, otherwise
    // the wiring has no coverage at all. The real `__DEV__` gating of the Cashu
    // row is covered in __tests__/components/profile/Settings.test.tsx.
    Settings: ({
      onViewRewardSettings,
      onViewCashuCardDebug,
    }: {
      onViewRewardSettings: () => void;
      onViewCashuCardDebug?: () => void;
    }) =>
      MockReact.createElement(
        MockReact.Fragment,
        null,
        MockReact.createElement(
          TouchableOpacity,
          {key: 'rewards', onPress: onViewRewardSettings},
          MockReact.createElement(Text, null, 'Reward Settings'),
        ),
        MockReact.createElement(
          TouchableOpacity,
          {key: 'cashu', onPress: onViewCashuCardDebug},
          MockReact.createElement(Text, null, 'Cashu card (dev)'),
        ),
      ),
    Security: () => MockReact.createElement(Text, null, 'Security'),
    Transactions: () => MockReact.createElement(Text, null, 'Transactions'),
  };
});

jest.mock('../../src/components', () => {
  const MockReact = require('react');
  const {Text} = require('react-native');

  return {
    PinModal: ({visible, mode}: {visible: boolean; mode: string}) =>
      visible ? MockReact.createElement(Text, null, `PinModal:${mode}`) : null,
    TextButton: ({title}: {title: string}) =>
      MockReact.createElement(Text, null, title),
  };
});

const renderProfile = () => {
  const store = configureStore({
    reducer: rootReducer,
  });

  return render(
    <Provider store={store}>
      <Profile />
    </Provider>,
  );
};

describe('Profile rewards settings access', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('opens the disabled rewards settings screen without asking for a PIN', () => {
    mockIsRewardsEnabled.mockReturnValue(false);
    const {getByText, queryByText} = renderProfile();

    fireEvent.press(getByText('Reward Settings'));

    expect(mockNavigate).toHaveBeenCalledWith('RewardsSettings');
    expect(queryByText(/PinModal/)).toBeNull();
  });

  it('keeps PIN protection when rewards are enabled', () => {
    mockIsRewardsEnabled.mockReturnValue(true);
    const {getByText} = renderProfile();

    fireEvent.press(getByText('Reward Settings'));

    expect(mockNavigate).not.toHaveBeenCalled();
    expect(getByText('PinModal:setup')).toBeTruthy();
  });
});

// Three gates keep the dev-only harness out of release builds: the row
// (components/profile/Settings.tsx), this navigate call, and the route
// registration (routes/index.tsx). This covers the middle one.
describe('Profile Cashu card debug wiring', () => {
  const devGlobal = global as unknown as {__DEV__: boolean};
  const originalDev = devGlobal.__DEV__;

  beforeEach(() => {
    jest.clearAllMocks();
    mockIsRewardsEnabled.mockReturnValue(false);
  });

  afterEach(() => {
    devGlobal.__DEV__ = originalDev;
  });

  it('navigates to the harness in a dev build', () => {
    devGlobal.__DEV__ = true;
    const {getByText} = renderProfile();

    fireEvent.press(getByText('Cashu card (dev)'));

    expect(mockNavigate).toHaveBeenCalledWith('CashuCardDebug');
  });

  // `RootStackType` declares the route unconditionally, so this typechecks in a
  // release build and then throws an unhandled NAVIGATE at runtime.
  it('does not navigate in a release build', () => {
    devGlobal.__DEV__ = false;
    const {getByText} = renderProfile();

    fireEvent.press(getByText('Cashu card (dev)'));

    expect(mockNavigate).not.toHaveBeenCalled();
  });
});
