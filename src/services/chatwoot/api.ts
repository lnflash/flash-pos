import chatwootConfig from './config';
import type {
  ChatwootMessage,
  ChatwootConversation,
} from './types';

type AuthSession = {
  authToken: string;
  conversationId: number;
};

/**
 * Response from POST /api/v1/widget/conversations
 * The conversation + initial message are created atomically.
 */
type CreateConversationResponse = ChatwootConversation & {
  messages?: ChatwootMessage[];
  contact_last_seen_at?: number;
};

/**
 * Response from GET /api/v1/widget/messages
 */
type MessagesResponse = {
  payload: ChatwootMessage[];
};

const QUERY = `?website_token=${chatwootConfig.websiteToken}`;

/**
 * Fetch the widget page HTML and extract the JWT authToken
 * that Chatwoot injects via `window.authToken = '...'`.
 */
const fetchWidgetAuthToken = async (): Promise<string> => {
  const response = await fetch(
    `${chatwootConfig.baseUrl}/widget${QUERY}`,
  );

  if (!response.ok) {
    throw new Error(
      `Failed to fetch widget page: ${response.status} ${response.statusText}`,
    );
  }

  const html = await response.text();
  const match = html.match(/authToken\s*=\s*'([^']+)'/);

  if (!match || !match[1]) {
    throw new Error('Widget authToken not found in page HTML');
  }

  return match[1];
};

const buildUrl = (path: string): string =>
  `${chatwootConfig.apiBase}${path}${QUERY}`;

const authedRequest = async <T>(
  url: string,
  authToken: string,
  options: RequestInit = {},
): Promise<T> => {
  const response = await fetch(url, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      'X-Auth-Token': authToken,
      ...options.headers,
    },
  });

  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new Error(
      `Chatwoot API ${response.status}: ${body || response.statusText}`,
    );
  }

  return response.json() as Promise<T>;
};

/**
 * Initialize a support chat session:
 * 1. Fetch the widget page to get the JWT authToken
 * 2. Create a new conversation with an initial message
 * Returns the auth token + conversation ID.
 */
export const initSession = async (
  contactName?: string,
  initialMessage?: string,
): Promise<AuthSession> => {
  // Step 1: Get JWT auth token from widget page
  const authToken = await fetchWidgetAuthToken();

  // Step 2: Create conversation — Chatwoot requires an initial message
  const body: Record<string, unknown> = {
    message: {
      content: initialMessage || '👋 Hi! I need help with Flash POS.',
      timestamp: new Date().toString(),
    },
  };

  if (contactName) {
    body.contact = {name: contactName};
  }

  const data = await authedRequest<CreateConversationResponse>(
    buildUrl('/conversations'),
    authToken,
    {
      method: 'POST',
      body: JSON.stringify(body),
    },
  );

  return {
    authToken,
    conversationId: data.id,
  };
};

export const getMessages = async (
  conversationId: number,
  authToken: string,
): Promise<ChatwootMessage[]> => {
  const data = await authedRequest<MessagesResponse>(
    buildUrl('/messages'),
    authToken,
    {method: 'GET'},
  );

  return data.payload ?? [];
};

export const sendMessage = async (
  conversationId: number,
  authToken: string,
  content: string,
): Promise<ChatwootMessage> => {
  return authedRequest<ChatwootMessage>(
    buildUrl('/messages'),
    authToken,
    {
      method: 'POST',
      body: JSON.stringify({
        message: {
          content,
          timestamp: new Date().toString(),
        },
      }),
    },
  );
};

export const updateLastSeen = async (
  conversationId: number,
  authToken: string,
): Promise<void> => {
  await authedRequest(
    buildUrl('/conversations/update_last_seen'),
    authToken,
    {
      method: 'POST',
      body: JSON.stringify({
        contact_last_seen_at: Math.floor(Date.now() / 1000),
      }),
    },
  ).catch(() => {
    // Best-effort — don't block UI on read receipts
  });
};
