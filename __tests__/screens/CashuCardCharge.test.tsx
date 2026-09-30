import React from 'react';
import {act, fireEvent, render, waitFor} from '@testing-library/react-native';
import {Provider} from 'react-redux';
import {configureStore} from '@reduxjs/toolkit';

import CashuCardCharge from '../../src/screens/CashuCardCharge';
import amountSlice from '../../src/store/slices/amountSlice';
import userSlice from '../../src/store/slices/userSlice';
import invoiceSlice from '../../src/store/slices/invoiceSlice';
import transactionHistorySlice from '../../src/store/slices/transactionHistorySlice';

const mockWithCardSession = jest.fn();
const mockCancelCardSession = jest.fn();
const mockSetCardSessionMessage = jest.fn();
const mockExecuteCharge = jest.fn();
const mockReadAndPlan = jest.fn();
const mockRunAutoSettlement = jest.fn();

jest.mock('../../src/services/cashuCardNfc', () => ({
  cancelCardSession: (...args: unknown[]) => mockCancelCardSession(...args),
  isCardReadingSupported: () => Promise.resolve(true),
  setCardSessionMessage: (...args: unknown[]) => mockSetCardSessionMessage(...args),
  withCardSession: (...args: unknown[]) => mockWithCardSession(...args),
  describeCardFailure: jest.requireActual('../../src/services/cashuCardNfc').describeCardFailure,
  isUserCancel: jest.requireActual('../../src/services/cashuCardNfc').isUserCancel,
}));

jest.mock('../../src/services/cashuCharge', () => ({
  executeCharge: (...args: unknown[]) => mockExecuteCharge(...args),
  readAndPlan: (...args: unknown[]) => mockReadAndPlan(...args),
}));

jest.mock('../../src/services/cashuAutoSettle', () => ({
  runAutoSettlement: (...args: unknown[]) => mockRunAutoSettlement(...args),
}));

// The stage is the animation leaf; the screen test only cares that it gets
// the mapped state and mode, the way Success.test.tsx mocks the barrel.
jest.mock('../../src/components/cashu/charge/SparkStage', () => {
  const MockReact = require('react');
  const {Text} = require('react-native');
  const Stage = ({
    state,
    mode,
    docked,
    burnCoins = [],
    changeSat = 0,
  }: {
    state: {station: number; seq: number};
    mode: string;
    docked?: boolean;
    burnCoins?: number[];
    changeSat?: number;
  }) =>
    MockReact.createElement(
      Text,
      {testID: 'spark-stage', burnCoins, changeSat},
      `${mode}:${state.station}:${state.seq}${docked ? ':docked' : ''}`,
    );
  return {__esModule: true, default: Stage, ProgressRail: () => null};
});

const PLAN = {
  plan: {slots: [1, 2], burnedSat: 24, changeSat: 8},
  unspent: [
    {slot: 1, amount: 16},
    {slot: 2, amount: 8},
  ],
  cardPubkey: '02'.padEnd(66, 'ab'),
  pinRequired: false,
};

/** Renders and drains the `isCardReadingSupported` effect. */
const renderScreen = async (params: Record<string, unknown> = {}) => {
  const store = configureStore({
    reducer: {
      amount: amountSlice,
      user: userSlice,
      invoice: invoiceSlice,
      transactionHistory: transactionHistorySlice,
    },
    preloadedState: {
      amount: {
        ...amountSlice(undefined, {type: 'init'}),
        isPrimaryAmountSats: true,
        displayAmount: '16',
        satAmount: '16',
      },
      user: {...userSlice(undefined, {type: 'init'}), username: 'merchant'},
      invoice: invoiceSlice(undefined, {type: 'init'}),
      transactionHistory: transactionHistorySlice(undefined, {type: 'init'}),
    },
  });
  const navigation = {pop: jest.fn(), navigate: jest.fn(), setParams: jest.fn()};
  const utils = render(
    <Provider store={store}>
      <CashuCardCharge navigation={navigation as never} route={{params} as never} />
    </Provider>,
  );
  await act(async () => {});
  return {...utils, navigation, store};
};

beforeEach(() => {
  jest.clearAllMocks();
  mockCancelCardSession.mockResolvedValue(undefined);
  mockRunAutoSettlement.mockResolvedValue(undefined);
  // The session runs its callback with a fake transceiver: the service mocks
  // decide what happens inside.
  mockWithCardSession.mockImplementation((fn: (t: unknown) => Promise<unknown>) => fn(jest.fn()));
});

describe('CashuCardCharge', () => {
  it('shows the idle stage and the tap button before any charge', async () => {
    const {getByText, getByTestId} = await renderScreen();
    expect(getByText('Charge by eCash card')).toBeTruthy();
    expect(getByText('16 sats')).toBeTruthy();
    expect(getByText('Tap card to charge')).toBeTruthy();
    expect(getByTestId('spark-stage').props.children).toBe('idle:0:0');
    expect(getByText('yes')).toBeTruthy();
  });

  it('feeds every phase (repeats included) to the stage and hands off on complete', async () => {
    jest.useFakeTimers();
    let release!: () => void;
    const gate = new Promise<void>(resolve => {
      release = resolve;
    });
    mockReadAndPlan.mockImplementation(async ({onPhase}: {onPhase: (p: string) => void}) => {
      onPhase('reading card');
      onPhase('reading card');
      return PLAN;
    });
    mockExecuteCharge.mockImplementation(async ({onPhase}: {onPhase: (p: string) => void}) => {
      onPhase('reading card');
      onPhase('burning 16 sat (proof 1/2)');
      onPhase('burning 8 sat (proof 2/2)');
      onPhase('settling payment and minting change');
      onPhase('writing change to card');
      onPhase('writing change to card');
      onPhase('reading card');
      await gate;
      return {amountSat: 16, burned: [], changeSat: 8, changeLoaded: 2, balanceAfter: 8};
    });

    const {getByText, getByTestId, navigation, store} = await renderScreen();
    await act(async () => {
      fireEvent.press(getByText('Tap card to charge'));
    });

    // The last phase before the gate: the trailing read resolved station 5,
    // with all nine phases (two identical 'reading card's, two identical
    // change writes) counted by seq, not collapsed by string.
    expect(getByTestId('spark-stage').props.children).toBe('running:5:9');
    expect(getByTestId('phase-title').props.children).toBe('Checking the card');
    expect(getByTestId('phase-raw').props.children).toBe('reading card');
    expect(mockSetCardSessionMessage).toHaveBeenLastCalledWith('Checking the card');
    expect(getByText('Cancel read')).toBeTruthy();

    await act(async () => {
      release();
    });
    // The customer is told to lift the card the moment the session resolves,
    // before settlement and navigation.
    expect(getByTestId('spark-stage').props.children).toBe('complete:5:9');
    expect(getByText('Paid — you can lift the card')).toBeTruthy();
    expect(navigation.navigate).not.toHaveBeenCalled();

    await act(async () => {
      jest.advanceTimersByTime(900);
    });
    await waitFor(() => expect(navigation.navigate).toHaveBeenCalledWith('Success', {
      title: 'Charged 16 sats — paid by eCash card',
    }));
    expect(mockRunAutoSettlement).toHaveBeenCalledWith('merchant');
    expect(navigation.pop).toHaveBeenCalledWith(2);
    expect(store.getState().transactionHistory.transactions[0]).toMatchObject({
      transactionType: 'ecash',
      paymentMethod: 'card',
    });
    jest.useRealTimers();
  });

  it('keeps the stage in error mode with the phase it died on, and resets on retry', async () => {
    mockReadAndPlan.mockImplementation(async ({onPhase}: {onPhase: (p: string) => void}) => {
      onPhase('reading card');
      return PLAN;
    });
    mockExecuteCharge
      .mockImplementationOnce(async ({onPhase}: {onPhase: (p: string) => void}) => {
        onPhase('reading card');
        onPhase('burning 16 sat (proof 1/2)');
        throw new Error('[burning 16 sat (proof 1/2)] tag lost');
      })
      .mockImplementation(async ({onPhase}: {onPhase: (p: string) => void}) => {
        onPhase('reading card');
        return {amountSat: 16, burned: [], changeSat: 8, changeLoaded: 0, balanceAfter: 8};
      });

    const {getByText, getByTestId, navigation} = await renderScreen();
    await act(async () => {
      fireEvent.press(getByText('Tap card to charge'));
    });
    expect(getByTestId('spark-stage').props.children).toBe('error:3:3');
    expect(getByText(/tag lost/)).toBeTruthy();
    expect(getByText('Tap card to charge')).toBeTruthy();
    expect(navigation.navigate).not.toHaveBeenCalled();

    await act(async () => {
      fireEvent.press(getByText('Tap card to charge'));
    });
    // A fresh session starts from station 1 again — never from station 3.
    await waitFor(() => expect(navigation.navigate).toHaveBeenCalled());
    expect(getByTestId('spark-stage').props.children).toMatch(/^complete:1:/);
    // Drain the finally-block state updates that follow navigation.
    await act(async () => {});
  });

  it('records the charge but never navigates when the screen unmounts during the held frame', async () => {
    jest.useFakeTimers();
    mockReadAndPlan.mockResolvedValue(PLAN);
    mockExecuteCharge.mockResolvedValue({amountSat: 16, burned: [], changeSat: 8, changeLoaded: 1, balanceAfter: 8});
    const {getByText, navigation, store, unmount} = await renderScreen();
    await act(async () => {
      fireEvent.press(getByText('Tap card to charge'));
    });
    expect(getByText('Paid — you can lift the card')).toBeTruthy();
    // Hardware Back inside LIFT_HOLD_MS: the merchant is on another screen
    // by the time the hold ends, and pop(2) there would eat two of ITS screens.
    unmount();
    await act(async () => {
      jest.advanceTimersByTime(900);
    });
    await act(async () => {});
    expect(store.getState().transactionHistory.transactions[0]).toMatchObject({
      transactionType: 'ecash',
      amount: {satAmount: 16},
    });
    expect(navigation.pop).not.toHaveBeenCalled();
    expect(navigation.navigate).not.toHaveBeenCalled();
    jest.useRealTimers();
  });

  it('clears the previous card\'s plan when a retry starts', async () => {
    mockReadAndPlan
      .mockResolvedValueOnce(PLAN)
      .mockImplementationOnce(() => new Promise(() => {}));
    mockExecuteCharge.mockRejectedValueOnce(new Error('[burning 16 sat (proof 1/2)] tag lost'));
    const {getByText, getByTestId} = await renderScreen();
    await act(async () => {
      fireEvent.press(getByText('Tap card to charge'));
    });
    expect(getByText(/tag lost/)).toBeTruthy();
    expect(getByTestId('spark-stage').props.burnCoins).toEqual([16, 8]);
    expect(getByTestId('spark-stage').props.changeSat).toBe(8);

    // Session 1 of the retry is pending: the stage must show only real money
    // state, not the last card's proofs seated on the disc.
    await act(async () => {
      fireEvent.press(getByText('Tap card to charge'));
    });
    expect(getByTestId('spark-stage').props.burnCoins).toEqual([]);
    expect(getByTestId('spark-stage').props.changeSat).toBe(0);
  });

  it('docks the stage behind the PIN pad when the router pre-read a PIN card', async () => {
    const {getByTestId, getByText, navigation} = await renderScreen({preRead: {...PLAN, pinRequired: true}});
    expect(navigation.setParams).toHaveBeenCalledWith({preRead: undefined});
    expect(getByText('Enter card PIN')).toBeTruthy();
    expect(getByTestId('spark-stage').props.children).toBe('idle:0:0:docked');
  });

  it('cancels the NFC session on Cancel and on unmount', async () => {
    mockWithCardSession.mockImplementation(() => new Promise(() => {}));
    const {getByText, unmount} = await renderScreen();
    await act(async () => {
      fireEvent.press(getByText('Tap card to charge'));
    });
    fireEvent.press(getByText('Cancel read'));
    expect(mockCancelCardSession).toHaveBeenCalledTimes(1);
    unmount();
    expect(mockCancelCardSession).toHaveBeenCalledTimes(2);
  });
});
