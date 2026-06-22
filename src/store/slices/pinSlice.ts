import {createAsyncThunk, createSlice} from '@reduxjs/toolkit';
import {pbkdf2Async} from '@noble/hashes/pbkdf2';
import {sha256} from '@noble/hashes/sha256';
import {bytesToHex, hexToBytes, utf8ToBytes} from '@noble/hashes/utils';

import {RootState} from '..';
import {getSecure, removeSecure, setSecure} from '../../services/secureStorage';

interface PinState {
  hasPin: boolean;
  isAuthenticated: boolean;
  lastAuthTime: number | null;
  sessionTimeout: number; // minutes
  lastVerificationResult: 'success' | 'failure' | null;
  lastOperationResult: 'success' | 'failure' | null;
}

type PinRecord = {
  version: 1;
  algorithm: 'pbkdf2-sha256';
  iterations: number;
  salt: string;
  hash: string;
};

const PIN_RECORD_KEY = '@flash-pos-pin-hash';
const PIN_SALT_KEY = '@flash-pos-pin-device-salt';
const PIN_HASH_ITERATIONS = 10000;
const PIN_HASH_LENGTH_BYTES = 32;
const PIN_HASH_ASYNC_TICK_MS = 2;

const initialState: PinState = {
  hasPin: false,
  isAuthenticated: false,
  lastAuthTime: null,
  sessionTimeout: 15, // 15 minutes default
  lastVerificationResult: null,
  lastOperationResult: null,
};

const constantTimeEqual = (left: string, right: string): boolean => {
  if (left.length !== right.length) {
    return false;
  }

  let diff = 0;
  for (let i = 0; i < left.length; i++) {
    diff += Number(left.charCodeAt(i) !== right.charCodeAt(i));
  }

  return diff === 0;
};

const getDeviceSalt = async (): Promise<string> => {
  const existingSalt = await getSecure(PIN_SALT_KEY);
  if (existingSalt) {
    return existingSalt;
  }

  const saltSeed = [
    'flash-pos',
    Date.now().toString(36),
    Math.random().toString(36).slice(2),
    Math.random().toString(36).slice(2),
  ].join(':');
  const salt = bytesToHex(sha256(utf8ToBytes(saltSeed)));
  await setSecure(PIN_SALT_KEY, salt);
  return salt;
};

const hashPin = async (
  pin: string,
  salt: string,
  iterations = PIN_HASH_ITERATIONS,
): Promise<string> => {
  return bytesToHex(
    await pbkdf2Async(sha256, utf8ToBytes(pin), hexToBytes(salt), {
      c: iterations,
      dkLen: PIN_HASH_LENGTH_BYTES,
      asyncTick: PIN_HASH_ASYNC_TICK_MS,
    }),
  );
};

const createPinRecord = async (pin: string): Promise<PinRecord> => {
  const salt = await getDeviceSalt();

  return {
    version: 1,
    algorithm: 'pbkdf2-sha256',
    iterations: PIN_HASH_ITERATIONS,
    salt,
    hash: await hashPin(pin, salt, PIN_HASH_ITERATIONS),
  };
};

const parsePinRecord = (recordJson: string | null): PinRecord | null => {
  if (!recordJson) {
    return null;
  }

  try {
    const parsed = JSON.parse(recordJson) as Partial<PinRecord>;
    if (
      parsed.version !== 1 ||
      parsed.algorithm !== 'pbkdf2-sha256' ||
      typeof parsed.salt !== 'string' ||
      typeof parsed.hash !== 'string'
    ) {
      return null;
    }

    return {
      version: 1,
      algorithm: 'pbkdf2-sha256',
      iterations: parsed.iterations ?? PIN_HASH_ITERATIONS,
      salt: parsed.salt,
      hash: parsed.hash,
    };
  } catch {
    return null;
  }
};

export const verifyPin = async (pin: string): Promise<boolean> => {
  const record = parsePinRecord(await getSecure(PIN_RECORD_KEY));
  if (!record) {
    return false;
  }

  const verified = constantTimeEqual(
    await hashPin(pin, record.salt, record.iterations),
    record.hash,
  );

  if (verified && record.iterations !== PIN_HASH_ITERATIONS) {
    const upgradedRecord = await createPinRecord(pin);
    await setSecure(PIN_RECORD_KEY, JSON.stringify(upgradedRecord));
  }

  return verified;
};

export const loadPinState = createAsyncThunk('pin/loadPinState', async () => {
  return parsePinRecord(await getSecure(PIN_RECORD_KEY)) !== null;
});

export const setPin = createAsyncThunk('pin/setPin', async (pin: string) => {
  const record = await createPinRecord(pin);
  await setSecure(PIN_RECORD_KEY, JSON.stringify(record));
});

export const changePin = createAsyncThunk(
  'pin/changePin',
  async ({oldPin, newPin}: {oldPin: string; newPin: string}) => {
    if (!(await verifyPin(oldPin))) {
      return false;
    }

    const record = await createPinRecord(newPin);
    await setSecure(PIN_RECORD_KEY, JSON.stringify(record));
    return true;
  },
);

export const authenticatePin = createAsyncThunk(
  'pin/authenticatePin',
  async (pin: string) => verifyPin(pin),
);

export const verifyPinOnly = createAsyncThunk(
  'pin/verifyPinOnly',
  async (pin: string) => verifyPin(pin),
);

export const removePin = createAsyncThunk('pin/removePin', async () => {
  await removeSecure(PIN_RECORD_KEY);
  await removeSecure(PIN_SALT_KEY);
});

export const pinSlice = createSlice({
  name: 'pin',
  initialState,
  reducers: {
    clearAuthentication: state => {
      state.isAuthenticated = false;
      state.lastAuthTime = null;
      state.lastVerificationResult = null;
    },

    clearResults: state => {
      state.lastVerificationResult = null;
      state.lastOperationResult = null;
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
  extraReducers: builder => {
    builder
      .addCase(loadPinState.fulfilled, (state, action) => {
        state.hasPin = action.payload;
      })
      .addCase(setPin.fulfilled, state => {
        state.hasPin = true;
        state.isAuthenticated = true;
        state.lastAuthTime = Date.now();
        state.lastOperationResult = 'success';
        state.lastVerificationResult = 'success';
      })
      .addCase(setPin.rejected, state => {
        state.lastOperationResult = 'failure';
        state.lastVerificationResult = 'failure';
      })
      .addCase(changePin.fulfilled, (state, action) => {
        if (action.payload) {
          state.hasPin = true;
          state.isAuthenticated = true;
          state.lastAuthTime = Date.now();
          state.lastOperationResult = 'success';
          state.lastVerificationResult = 'success';
        } else {
          state.isAuthenticated = false;
          state.lastAuthTime = null;
          state.lastOperationResult = 'failure';
          state.lastVerificationResult = 'failure';
        }
      })
      .addCase(changePin.rejected, state => {
        state.isAuthenticated = false;
        state.lastAuthTime = null;
        state.lastOperationResult = 'failure';
        state.lastVerificationResult = 'failure';
      })
      .addCase(authenticatePin.pending, state => {
        state.lastVerificationResult = null;
      })
      .addCase(authenticatePin.fulfilled, (state, action) => {
        if (action.payload) {
          state.isAuthenticated = true;
          state.lastAuthTime = Date.now();
          state.lastVerificationResult = 'success';
        } else {
          state.isAuthenticated = false;
          state.lastAuthTime = null;
          state.lastVerificationResult = 'failure';
        }
      })
      .addCase(authenticatePin.rejected, state => {
        state.isAuthenticated = false;
        state.lastAuthTime = null;
        state.lastVerificationResult = 'failure';
      })
      .addCase(verifyPinOnly.pending, state => {
        state.lastVerificationResult = null;
      })
      .addCase(verifyPinOnly.fulfilled, (state, action) => {
        state.lastVerificationResult = action.payload ? 'success' : 'failure';
      })
      .addCase(verifyPinOnly.rejected, state => {
        state.lastVerificationResult = 'failure';
      })
      .addCase(removePin.fulfilled, state => {
        state.hasPin = false;
        state.isAuthenticated = false;
        state.lastAuthTime = null;
        state.lastVerificationResult = null;
        state.lastOperationResult = 'success';
      })
      .addCase(removePin.rejected, state => {
        state.lastOperationResult = 'failure';
      });
  },
});

export const {clearAuthentication, clearResults, checkSession} =
  pinSlice.actions;

// Selectors
export const selectHasPin = (state: RootState) => state.pin.hasPin;
export const selectIsAuthenticated = (state: RootState) =>
  state.pin.isAuthenticated;
export const selectPinState = (state: RootState) => state.pin;
export const selectLastVerificationResult = (state: RootState) =>
  state.pin.lastVerificationResult;
export const selectLastOperationResult = (state: RootState) =>
  state.pin.lastOperationResult;

export default pinSlice.reducer;
