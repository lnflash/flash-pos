import {createSlice, PayloadAction} from '@reduxjs/toolkit';
import {RootState} from '..';

interface PinState {
  hasPin: boolean;
  pinHash: string | null;
  isAuthenticated: boolean;
  lastAuthTime: number | null;
  sessionTimeout: number; // minutes
  // New fields for better error handling
  lastVerificationResult: 'success' | 'failure' | null;
  lastOperationResult: 'success' | 'failure' | null;
}

const initialState: PinState = {
  hasPin: false,
  pinHash: null,
  isAuthenticated: false,
  lastAuthTime: null,
  sessionTimeout: 15, // 15 minutes default
  lastVerificationResult: null,
  lastOperationResult: null,
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
      state.lastOperationResult = 'success';
      state.lastVerificationResult = 'success';
    },

    changePin: (
      state,
      action: PayloadAction<{oldPin: string; newPin: string}>,
    ) => {
      const {oldPin, newPin} = action.payload;

      // Verify old PIN first
      if (state.pinHash === hashPin(oldPin)) {
        state.pinHash = hashPin(newPin);
        state.isAuthenticated = true;
        state.lastAuthTime = Date.now();
        state.lastOperationResult = 'success';
        state.lastVerificationResult = 'success';
      } else {
        // Old PIN is incorrect
        state.isAuthenticated = false;
        state.lastAuthTime = null;
        state.lastOperationResult = 'failure';
        state.lastVerificationResult = 'failure';
      }
    },

    authenticatePin: (state, action: PayloadAction<string>) => {
      // Always reset verification result first
      state.lastVerificationResult = null;

      if (state.pinHash === hashPin(action.payload)) {
        state.isAuthenticated = true;
        state.lastAuthTime = Date.now();
        state.lastVerificationResult = 'success';
      } else {
        // Clear authentication if PIN is wrong
        state.isAuthenticated = false;
        state.lastAuthTime = null;
        state.lastVerificationResult = 'failure';
      }
    },

    // New action to verify PIN without changing authentication state
    verifyPinOnly: (state, action: PayloadAction<string>) => {
      state.lastVerificationResult = null;

      if (state.pinHash === hashPin(action.payload)) {
        state.lastVerificationResult = 'success';
      } else {
        state.lastVerificationResult = 'failure';
      }
    },

    clearAuthentication: state => {
      state.isAuthenticated = false;
      state.lastAuthTime = null;
      state.lastVerificationResult = null;
    },

    clearResults: state => {
      state.lastVerificationResult = null;
      state.lastOperationResult = null;
    },

    removePin: state => {
      state.hasPin = false;
      state.pinHash = null;
      state.isAuthenticated = false;
      state.lastAuthTime = null;
      state.lastVerificationResult = null;
      state.lastOperationResult = 'success';
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
  verifyPinOnly,
  clearAuthentication,
  clearResults,
  removePin,
  checkSession,
} = pinSlice.actions;

// Selectors
export const selectHasPin = (state: RootState) => state.pin.hasPin;
export const selectIsAuthenticated = (state: RootState) =>
  state.pin.isAuthenticated;
export const selectPinState = (state: RootState) => state.pin;
export const selectLastVerificationResult = (state: RootState) =>
  state.pin.lastVerificationResult;
export const selectLastOperationResult = (state: RootState) =>
  state.pin.lastOperationResult;

// Helper function to verify PIN without updating state
export const verifyPin = (pin: string, storedHash: string): boolean => {
  return hashPin(pin) === storedHash;
};

export default pinSlice.reducer;
