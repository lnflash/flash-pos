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
    Settings: ({
      onViewRewardSettings,
    }: {
      onViewRewardSettings: () => void;
    }) =>
      MockReact.createElement(
        TouchableOpacity,
        {onPress: onViewRewardSettings},
        MockReact.createElement(Text, null, 'Reward Settings'),
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
