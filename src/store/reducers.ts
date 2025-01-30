import {combineReducers} from '@reduxjs/toolkit';

// slices
import amountSlice from './slices/amountSlice';
import userSlice from './slices/userSlice';
import invoiceSlice from './slices/invoiceSlice';

export default combineReducers({
  amount: amountSlice,
  user: userSlice,
  invoice: invoiceSlice,
});
