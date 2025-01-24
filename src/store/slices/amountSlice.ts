import {createSlice} from '@reduxjs/toolkit';
import {AppThunk} from '..';

export const MAX_INPUT_VALUE_LENGTH = 14;

interface AmountSlice {
  currency: CurrencyItem;
  isPrimaryAmountSats: boolean;
  displayAmount?: string;
  satAmount?: string;
  memo?: string;
  loading: boolean;
  error: string;
}

const initialState: AmountSlice = {
  currency: {
    flag: '🇯🇲',
    fractionDigits: 2,
    id: 'JMD',
    name: 'Jamaican Dollar',
    symbol: 'J$',
  },
  isPrimaryAmountSats: false,
  displayAmount: undefined,
  satAmount: undefined,
  memo: '',
  loading: false,
  error: '',
};

export const amountSlice = createSlice({
  name: 'amount',
  initialState,
  reducers: {
    setCurrency: (state, action) => ({...state, currency: action.payload}),
    setIsPrimaryAmountSats: (state, action) => ({
      ...state,
      isPrimaryAmountSats: action.payload,
    }),
    setDisplayAmount: (state, action) => ({
      ...state,
      displayAmount: action.payload,
    }),
    setSatAmount: (state, action) => ({
      ...state,
      satAmount: action.payload,
    }),
    setMemo: (state, action) => ({
      ...state,
      memo: action.payload,
    }),
    setLoading: (state, action) => ({
      ...state,
      loading: action.payload,
    }),
    setError: (state, action) => ({
      ...state,
      error: action.payload,
    }),
    resetAmount: state => ({
      ...initialState,
      currency: state.currency,
    }),
  },
});

export const {
  setCurrency,
  setIsPrimaryAmountSats,
  setDisplayAmount,
  setSatAmount,
  setMemo,
  setLoading,
  setError,
  resetAmount,
} = amountSlice.actions;
export default amountSlice.reducer;

export const updateAmount =
  (type: string, digit?: string): AppThunk =>
  async (dispatch, getState) => {
    const {satAmount, displayAmount, isPrimaryAmountSats} = getState().amount;

    try {
      let currentAmount = isPrimaryAmountSats ? satAmount : displayAmount;

      switch (type) {
        case 'addDigit':
          if (
            (digit == '0' && currentAmount == '0') ||
            (digit === '.' && currentAmount?.includes('.')) ||
            currentAmount?.match(/(\.[0-9]{2,}$|\..*\.)/) ||
            (currentAmount && currentAmount?.length >= MAX_INPUT_VALUE_LENGTH)
          ) {
            return;
          }

          if (digit === '.' && (currentAmount === '0' || !currentAmount)) {
            currentAmount = '0';
          }

          if (currentAmount === '0') {
            currentAmount = '';
          }

          currentAmount = `${currentAmount || ''}${digit}`;
          break;

        case 'deleteDigit':
          if (!!currentAmount) {
            currentAmount = currentAmount?.slice(0, -1);
          }
          break;

        case 'clearInput':
          currentAmount = undefined;
          break;
      }
      if (isPrimaryAmountSats) {
        dispatch(setSatAmount(currentAmount));
      } else {
        dispatch(setDisplayAmount(currentAmount));
      }
    } catch (err) {
      console.log('UPDATE AMOUNT ERROR: ', err);
    }
  };
