import {useCallback, useEffect, useRef, useState} from 'react';
import {Platform} from 'react-native';

import * as chatwootApi from '../services/chatwoot/api';
import {loadSession, saveSession, clearSession} from '../services/chatwoot/storage';
import {ChatwootSocket} from '../services/chatwoot/socket';
import type {
  ChatwootMessage,
  ChatwootSession,
  ChatwootWsEvent,
} from '../services/chatwoot/types';

export type ConnectionStatus =
  | 'connecting'
  | 'connected'
  | 'disconnected'
  | 'error';

type UseSupportChatOptions = {
  userIdentifier?: string;
  userDisplayName?: string;
  /** App version string, e.g. from package.json or native build */
  appVersion?: string;
};

type UseSupportChatResult = {
  messages: ChatwootMessage[];
  connectionStatus: ConnectionStatus;
  error: string | null;
  sendMessage: (content: string) => Promise<void>;
  retry: () => void;
  isSending: boolean;
};

const sortMessages = (list: ChatwootMessage[]): ChatwootMessage[] =>
  [...list].sort((a, b) => a.created_at - b.created_at);

const dedupeById = (list: ChatwootMessage[]): ChatwootMessage[] => {
  const seen = new Set<number>();
  return list.filter(msg => {
    if (seen.has(msg.id)) {
      return false;
    }

    seen.add(msg.id);
    return true;
  });
};

export const useSupportChat = (
  options: UseSupportChatOptions = {},
): UseSupportChatResult => {
  const {userDisplayName} = options;
  const [messages, setMessages] = useState<ChatwootMessage[]>([]);
  const [connectionStatus, setConnectionStatus] =
    useState<ConnectionStatus>('connecting');
  const [error, setError] = useState<string | null>(null);
  const [isSending, setIsSending] = useState(false);

  const socketRef = useRef<ChatwootSocket | null>(null);
  const sessionRef = useRef<ChatwootSession | null>(null);
  const initToken = useRef(0);

  const initialize = useCallback(async () => {
    const token = ++initToken.current;
    setError(null);
    setConnectionStatus('connecting');

    try {
      // 1. Load or create session
      let session: ChatwootSession | null = await loadSession();

      if (!session) {
        const contactName =
          userDisplayName ||
          `Flash POS (${Platform.OS})`;

        const osVersion =
          typeof Platform.Version === 'number'
            ? Platform.Version.toString()
            : String(Platform.Version ?? 'unknown');

        const deviceInfo = [
          `Flash POS v${options.appVersion ?? '0.3.1'}`,
          Platform.OS === 'ios' ? 'iOS' : 'Android',
          Platform.OS === 'ios' ? `iOS ${osVersion}` : `Android API ${osVersion}`,
        ].join(' • ');

        const userLine = userDisplayName
          ? `Merchant: ${userDisplayName}\n`
          : '';

        const initialMessage = `💬 Support session started\n${userLine}${deviceInfo}`;

        session = await chatwootApi.initSession(contactName, initialMessage);
        await saveSession(session);
      }

      if (token !== initToken.current) {
        return;
      }

      // After the above, session is non-null (either loaded or just created)
      if (!session) {
        throw new Error('Failed to create support session');
      }

      sessionRef.current = session;

      // 2. Load message history
      const activeSession: ChatwootSession = session;
      const history = await chatwootApi.getMessages(
        activeSession.conversationId,
        activeSession.authToken,
      );

      if (token !== initToken.current) {
        return;
      }

      setMessages(sortMessages(dedupeById(history)));
      chatwootApi.updateLastSeen(activeSession.conversationId, activeSession.authToken);

      // 3. Connect WebSocket for real-time updates
      const socket = new ChatwootSocket(activeSession.authToken, {
        onConnect: () => {
          if (token === initToken.current) {
            setConnectionStatus('connected');
          }
        },
        onDisconnect: () => {
          if (token === initToken.current) {
            setConnectionStatus('disconnected');
          }
        },
        onEvent: (event: ChatwootWsEvent) => {
          if (token !== initToken.current) {
            return;
          }

          if (event.type === 'message_created') {
            const msg = event.data?.message;
            if (msg) {
              setMessages(prev =>
                sortMessages(dedupeById([...prev, msg])),
              );
            }
          }
        },
      });

      socketRef.current = socket;
      socket.connect();
    } catch (err) {
      if (token !== initToken.current) {
        return;
      }

      // Clear stale session if auth failed
      const message =
        err instanceof Error ? err.message : 'Failed to connect to support';

      if (message.includes('401') || message.includes('404')) {
        await clearSession();
      }

      setError(message);
      setConnectionStatus('error');
    }
  }, [userDisplayName, options.appVersion]);

  const sendMessage = useCallback(async (content: string) => {
    const trimmed = content.trim();

    if (!trimmed || !sessionRef.current) {
      return;
    }

    setIsSending(true);

    try {
      const sent = await chatwootApi.sendMessage(
        sessionRef.current.conversationId,
        sessionRef.current.authToken,
        trimmed,
      );

      setMessages(prev => sortMessages(dedupeById([...prev, sent])));
    } catch (err) {
      const message =
        err instanceof Error ? err.message : 'Failed to send message';
      setError(message);
    } finally {
      setIsSending(false);
    }
  }, []);

  const retry = useCallback(() => {
    if (socketRef.current) {
      socketRef.current.disconnect();
      socketRef.current = null;
    }

    initialize();
  }, [initialize]);

  useEffect(() => {
    const token = initToken.current;
    initialize();

    return () => {
      initToken.current = token + 1;
      socketRef.current?.disconnect();
      socketRef.current = null;
    };
  }, [initialize]);

  return {
    messages,
    connectionStatus,
    error,
    sendMessage,
    retry,
    isSending,
  };
};
