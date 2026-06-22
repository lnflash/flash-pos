import AsyncStorage from '@react-native-async-storage/async-storage';
import {loadSession, saveSession, clearSession} from '../../../src/services/chatwoot/storage';
import type {ChatwootSession} from '../../../src/services/chatwoot/types';

const validSession: ChatwootSession = {
  authToken: 'jwt.token.payload',
  conversationId: 42,
};

describe('Chatwoot storage', () => {
  beforeEach(() => {
    AsyncStorage.clear();
  });

  it('returns null when no session is stored', async () => {
    const result = await loadSession();
    expect(result).toBeNull();
  });

  it('round-trips a session through save and load', async () => {
    await saveSession(validSession);
    const result = await loadSession();
    expect(result).toEqual(validSession);
  });

  it('clears the session', async () => {
    await saveSession(validSession);
    await clearSession();
    const result = await loadSession();
    expect(result).toBeNull();
  });

  it('returns null for malformed data', async () => {
    await AsyncStorage.setItem('@chatwoot_widget_session', 'not json');
    const result = await loadSession();
    expect(result).toBeNull();
  });

  it('returns null when required fields are missing', async () => {
    await AsyncStorage.setItem(
      '@chatwoot_widget_session',
      JSON.stringify({authToken: 'x'}),
    );
    const result = await loadSession();
    expect(result).toBeNull();
  });
});
