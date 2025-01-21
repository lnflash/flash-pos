import {createSlice} from '@reduxjs/toolkit';

export const MAX_INPUT_VALUE_LENGTH = 14;

interface UserSlice {
  username: string;
  walletId: string;
  walletCurrency: string;
  loading: boolean;
  error: string;
}

const initialState: UserSlice = {
  username: '',
  walletId: '',
  walletCurrency: '',
  loading: false,
  error: '',
};

export const userSlice = createSlice({
  name: 'user',
  initialState,
  reducers: {
    setUserData: (state, action) => ({
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
    resetUserData: () => ({
      ...initialState,
    }),
  },
});

export const {setUserData, setLoading, setError, resetUserData} =
  userSlice.actions;

export default userSlice.reducer;
