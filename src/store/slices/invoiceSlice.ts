import {createSlice} from '@reduxjs/toolkit';

interface InvoiceSlice {
  paymentHash: string;
  paymentRequest: string;
  paymentSecret: string;
  loading: boolean;
  error: string;
}

const initialState: InvoiceSlice = {
  paymentHash: '',
  paymentRequest: '',
  paymentSecret: '',
  loading: false,
  error: '',
};

export const invoiceSlice = createSlice({
  name: 'invoice',
  initialState,
  reducers: {
    setInvoice: (state, action) => ({
      ...state,
      ...action.payload,
    }),
    setLoading: (state, action) => ({
      ...state,
      loading: action.payload,
    }),
    setError: (state, action) => ({
      ...state,
      error: action.payload,
    }),
    resetInvoice: () => ({
      ...initialState,
    }),
  },
});

export const {setInvoice, setLoading, setError, resetInvoice} =
  invoiceSlice.actions;

export default invoiceSlice.reducer;
