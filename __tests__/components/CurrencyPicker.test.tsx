import React from 'react';
import {fireEvent, render} from '@testing-library/react-native';

import CurrencyPicker from '../../src/components/modals/CurrencyPicker';

const mockDispatch = jest.fn();

jest.mock('react-native-vector-icons/FontAwesome6', () => 'Icon');

jest.mock('@apollo/client', () => ({
  ...jest.requireActual('@apollo/client'),
  useQuery: () => ({loading: false, data: undefined}),
}));

jest.mock('../../src/store/hooks', () => ({
  useAppDispatch: () => mockDispatch,
  useAppSelector: (selector: (state: unknown) => unknown) =>
    selector({
      amount: {
        currency: {id: 'JMD', name: 'Jamaican Dollar', flag: '', symbol: 'J$'},
        displayAmount: undefined,
      },
    }),
}));

jest.mock('../../src/hooks', () => ({
  useActivityIndicator: () => ({toggleLoading: jest.fn()}),
  useRealtimePrice: () => ({
    satsToCurrency: jest.fn(),
    currencyToSats: jest.fn(),
  }),
}));

beforeEach(() => mockDispatch.mockClear());

describe('CurrencyPicker accessibility (ENG-634)', () => {
  it('keeps every currency row reachable: the backdrop is not one accessible element', () => {
    const {getByText, getByTestId, UNSAFE_root} = render(<CurrencyPicker />);
    fireEvent.press(getByText('JMD'));

    // A touchable is accessible by default and hides its children from the
    // accessibility tree (VoiceOver, XCTest, Maestro). The backdrop wraps
    // the whole list, so it must opt out.
    const backdrop = UNSAFE_root.findAll(
      node => node.props.activeOpacity === 0.9 && !!node.props.onPress,
    )[0];
    expect(backdrop.props.accessible).toBe(false);

    fireEvent.press(getByTestId('currency-SAT'));
    expect(mockDispatch).toHaveBeenCalledWith(
      expect.objectContaining({payload: expect.objectContaining({id: 'SAT'})}),
    );
  });
});
