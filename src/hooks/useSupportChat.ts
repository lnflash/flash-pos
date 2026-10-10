import {useCallback, useEffect, useRef, useState} from 'react';
import {Platform} from 'react-native';

import * as chatwootApi from '../services/chatwoot/api';
import {
  loadSession,
  saveSession,
  clearSession,
} from '../services/chatwoot/storage';
import {ChatwootSocket} from '../services/chatwoot/socket';
import type {
  ChatwootMessage,
  ChatwootSession,
  ChatwootWsEvent,
} from '../services/chatwoot/types';
import {APP_VERSION} from '../utils/appVersion';

export type ConnectionStatus =
  | 'connecting'
  | 'connected'
  | 'disconnected'
  | 'error';

type UseSupportChatOptions = {
  userIdentifier?: string;
  userDisplayName?: string;
};

type UseSupportChatResult = {
  messages: ChatwootMessage[];
  connectionStatus: ConnectionStatus;
  error: string | null;
  sendMessage: (content: string) => Promise<void>;
  retry: () => void;
  isSending: boolean;
};

const isAuthError = (err: unknown): boolean =>
  err instanceof Error && /\b(401|404)\b/.test(err.message);

// "Flash POS v2.4.0 • iOS • iOS 17.4" — the line support reads to know what
// build they are talking to.
const buildDeviceInfo = (): string => {
  const osVersion =
    typeof Platform.Version === 'number'
      ? Platform.Version.toString()
      : String(Platform.Version ?? 'unknown');

  return [
    `Flash POS v${APP_VERSION}`,
    Platform.OS === 'ios' ? 'iOS' : 'Android',
    Platform.OS === 'ios' ? `iOS ${osVersion}` : `Android API ${osVersion}`,
  ].join(' • ');
};

const buildUserLine = (userDisplayName?: string): string =>
  userDisplayName ? `Merchant: ${userDisplayName}\n` : '';

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
      // 1. Load or create session. The device line goes out on session
      //    creation only; an existing conversation is never woken here
      //    (Chatwoot reopens resolved tickets on any incoming contact
      //    message). A stale appVersion stamp is caught up in sendMessage,
      //    right before the merchant's first real message.
      let session: ChatwootSession | null = await loadSession();

      if (!session) {
        const contactName = userDisplayName || `Flash POS (${Platform.OS})`;
        const initialMessage = `💬 Support session started\n${buildUserLine(
          userDisplayName,
        )}${buildDeviceInfo()}`;

        const created = await chatwootApi.initSession(
          contactName,
          initialMessage,
        );
        session = {...created, appVersion: APP_VERSION};
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
      chatwootApi.updateLastSeen(
        activeSession.conversationId,
        activeSession.authToken,
      );

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
              setMessages(prev => sortMessages(dedupeById([...prev, msg])));
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

      if (isAuthError(err)) {
        await clearSession();
      }

      setError(message);
      setConnectionStatus('error');
    }
  }, [userDisplayName]);

  const sendMessage = useCallback(
    async (content: string) => {
      const trimmed = content.trim();
      const session = sessionRef.current;

      if (!trimmed || !session) {
        return;
      }

      setIsSending(true);

      try {
        // A stored session last announced by a different build (or one that
        // predates the stamp) gets the current device line right before the
        // merchant's own message, so support reads the right version without
        // the conversation ever being reopened by an announce alone. On a
        // transport failure keep the old stamp so the next send retries; an
        // auth error is surfaced like any other send failure.
        if (session.appVersion !== APP_VERSION) {
          const updateMessage = `🔄 App updated\n${buildUserLine(
            userDisplayName,
          )}${buildDeviceInfo()}`;

          try {
            await chatwootApi.sendMessage(
              session.conversationId,
              session.authToken,
              updateMessage,
            );
            const stamped = {...session, appVersion: APP_VERSION};
            sessionRef.current = stamped;
            await saveSession(stamped);
          } catch (err) {
            if (isAuthError(err)) {
              throw err;
            }
          }
        }

        const sent = await chatwootApi.sendMessage(
          session.conversationId,
          session.authToken,
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
    },
    [userDisplayName],
  );

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
