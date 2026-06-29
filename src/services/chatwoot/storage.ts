import AsyncStorage from '@react-native-async-storage/async-storage';
import type {ChatwootSession} from './types';

const STORAGE_KEY = '@chatwoot_widget_session';

export const loadSession = async (): Promise<ChatwootSession | null> => {
  try {
    const raw = await AsyncStorage.getItem(STORAGE_KEY);
    if (!raw) {
      return null;
    }

    const parsed = JSON.parse(raw) as ChatwootSession;

    if (
      typeof parsed.authToken === 'string' &&
      typeof parsed.conversationId === 'number'
    ) {
      return parsed;
    }

    return null;
  } catch {
    return null;
  }
};

export const saveSession = async (session: ChatwootSession): Promise<void> => {
  await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(session));
};

export const clearSession = async (): Promise<void> => {
  await AsyncStorage.removeItem(STORAGE_KEY);
};
