import {createSlice, PayloadAction} from '@reduxjs/toolkit';
import {RootState} from '..';

interface PinState {
  hasPin: boolean;
  pinHash: string | null;
  isAuthenticated: boolean;
  lastAuthTime: number | null;
  sessionTimeout: number; // minutes
}

const initialState: PinState = {
  hasPin: false,
  pinHash: null,
  isAuthenticated: false,
  lastAuthTime: null,
  sessionTimeout: 15, // 15 minutes default
};

// Simple hash function for PIN (in production, use proper crypto)
const hashPin = (pin: string): string => {
  return btoa(pin + 'flash-pos-salt')
    .split('')
    .reverse()
    .join('');
};

export const pinSlice = createSlice({
  name: 'pin',
  initialState,
  reducers: {
    setPin: (state, action: PayloadAction<string>) => {
      state.hasPin = true;
      state.pinHash = hashPin(action.payload);
      state.isAuthenticated = true;
      state.lastAuthTime = Date.now();
    },

    changePin: (
      state,
      action: PayloadAction<{oldPin: string; newPin: string}>,
    ) => {
      const {oldPin, newPin} = action.payload;
      if (state.pinHash === hashPin(oldPin)) {
        state.pinHash = hashPin(newPin);
        state.isAuthenticated = true;
        state.lastAuthTime = Date.now();
      }
    },

    authenticatePin: (state, action: PayloadAction<string>) => {
      if (state.pinHash === hashPin(action.payload)) {
        state.isAuthenticated = true;
        state.lastAuthTime = Date.now();
      }
    },

    clearAuthentication: state => {
      state.isAuthenticated = false;
      state.lastAuthTime = null;
    },

    removePin: state => {
      state.hasPin = false;
      state.pinHash = null;
      state.isAuthenticated = false;
      state.lastAuthTime = null;
    },

    checkSession: state => {
      if (state.lastAuthTime && state.sessionTimeout) {
        const sessionExpired =
          Date.now() - state.lastAuthTime > state.sessionTimeout * 60 * 1000;
        if (sessionExpired) {
          state.isAuthenticated = false;
          state.lastAuthTime = null;
        }
      }
    },
  },
});

export const {
  setPin,
  changePin,
  authenticatePin,
  clearAuthentication,
  removePin,
  checkSession,
} = pinSlice.actions;

// Selectors
export const selectHasPin = (state: RootState) => state.pin.hasPin;
export const selectIsAuthenticated = (state: RootState) =>
  state.pin.isAuthenticated;
export const selectPinState = (state: RootState) => state.pin;

// Helper function to verify PIN without updating state
export const verifyPin = (pin: string, storedHash: string): boolean => {
  return hashPin(pin) === storedHash;
};

export default pinSlice.reducer;
