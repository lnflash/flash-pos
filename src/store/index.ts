import {configureStore, ThunkAction, Action} from '@reduxjs/toolkit';

import amountSlice from './slices/amountSlice';
import userSlice from './slices/userSlice';
import invoiceSlice from './slices/invoiceSlice';

export const store = configureStore({
  reducer: {
    amount: amountSlice,
    user: userSlice,
    invoice: invoiceSlice,
  },
});

export type AppDispatch = typeof store.dispatch;

export type RootState = ReturnType<typeof store.getState>;

export type AppThunk<ReturnType = void> = ThunkAction<
  ReturnType,
  RootState,
  unknown,
  Action<string>
>;
