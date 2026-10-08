import React from 'react';
import {Platform} from 'react-native';
import {fireEvent, render} from '@testing-library/react-native';

import Keypad from '../../src/screens/Keypad';

const mockReadOnce = jest.fn();
const mockReader = {reading: false};

jest.mock('@apollo/client', () => ({
  gql: (strings: TemplateStringsArray) => strings.join(''),
  useMutation: () => [jest.fn()],
}));

jest.mock('@react-navigation/native', () => ({
  useNavigation: () => ({navigate: jest.fn()}),
  useFocusEffect: (callback: () => void) => callback(),
}));

const mockState = {
  user: {walletId: 'wallet'},
  amount: {
    satAmount: '0',
    memo: '',
    displayAmount: '0',
    currency: {id: 'USD', symbol: '$', fractionDigits: 2},
    isPrimaryAmountSats: false,
  },
};

jest.mock('../../src/store/hooks', () => ({
  useAppDispatch: () => jest.fn(),
  useAppSelector: (selector: (state: unknown) => unknown) =>
    selector(mockState),
}));

jest.mock('../../src/store/slices/rewardSlice', () => ({
  selectRewardConfig: () => ({isEnabled: false}),
  selectEventConfig: () => ({eventModeEnabled: false, eventActive: false}),
}));

jest.mock('../../src/utils/featureFlags', () => ({
  isRewardsEnabled: () => false,
}));

jest.mock('../../src/hooks', () => ({
  useActivityIndicator: () => ({toggleLoading: jest.fn()}),
  useSatPrice: () => ({satsToUsd: () => 0.0005, refetchPrice: jest.fn()}),
  useRealtimePrice: () => ({
    currencyToSats: () => ({convertedCurrencyAmount: 0}),
  }),
  useKeypadCardReader: () => ({
    readOnce: mockReadOnce,
    reading: mockReader.reading,
  }),
}));

jest.mock('../../src/components', () => {
  const MockReact = require('react');
  const {Text, TouchableOpacity} = require('react-native');

  return {
    Amount: () => MockReact.createElement(Text, null, 'Amount'),
    Note: () => MockReact.createElement(Text, null, 'Note'),
    NumPad: () => MockReact.createElement(Text, null, 'NumPad'),
    PrimaryButton: ({btnText}: {btnText: string}) =>
      MockReact.createElement(Text, null, btnText),
    SecondaryButton: ({btnText}: {btnText: string}) =>
      MockReact.createElement(Text, null, btnText),
    TextButton: ({
      title,
      disabled,
      onPress,
    }: {
      title: string;
      disabled?: boolean;
      onPress: () => void;
    }) =>
      MockReact.createElement(
        TouchableOpacity,
        {onPress, disabled, accessibilityState: {disabled: !!disabled}},
        MockReact.createElement(Text, null, title),
      ),
  };
});

let platform: {restore: () => void} | undefined;
const setPlatform = (os: 'android' | 'ios') => {
  platform = jest.replaceProperty(Platform, 'OS', os);
};

beforeEach(() => {
  jest.clearAllMocks();
  mockReader.reading = false;
});

afterEach(() => {
  platform?.restore();
  platform = undefined;
});

describe('Keypad card balance control', () => {
  it('on iOS, offers a "Card balance" control that starts a one-shot read', () => {
    setPlatform('ios');
    const {getByText} = render(<Keypad />);

    fireEvent.press(getByText('Card balance'));

    expect(mockReadOnce).toHaveBeenCalledTimes(1);
  });

  it('on iOS, disables the control while a read is in flight', () => {
    setPlatform('ios');
    mockReader.reading = true;
    const {getByText} = render(<Keypad />);

    // A disabled touchable swallows the press (RNTL honours
    // accessibilityState.disabled), so a second read cannot start.
    fireEvent.press(getByText('Card balance'));

    expect(mockReadOnce).not.toHaveBeenCalled();
  });

  it('on Android, renders no extra control — the reader is armed while focused', () => {
    setPlatform('android');
    const {queryByText, getByText} = render(<Keypad />);

    expect(queryByText('Card balance')).toBeNull();
    expect(getByText('Next')).toBeTruthy();
  });
});
