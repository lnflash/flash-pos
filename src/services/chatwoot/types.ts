// Chatwoot Widget API types

export type ChatwootMessageType = 0 | 1 | 2 | 3;

export type ChatwootMessage = {
  id: number;
  content: string;
  message_type: ChatwootMessageType;
  created_at: number;
  conversation_id?: number;
  sender?: {
    name?: string;
    avatar_url?: string;
  };
  attachments?: Array<{
    file_type: string;
    data_url: string;
  }>;
};

export type ChatwootConversation = {
  id: number;
  uuid?: string;
  status?: 'open' | 'resolved' | 'pending' | 'snoozed';
  messages?: ChatwootMessage[];
};

// Local persistence shape

export type ChatwootSession = {
  authToken: string;
  conversationId: number;
};

// WebSocket message types

export type ChatwootWsEvent = {
  type?:
    | 'message_created'
    | 'message_updated'
    | 'conversation_created'
    | 'conversation_resolved'
    | 'conversation_read'
    | 'conversation_status_changed'
    | 'typing_on'
    | 'typing_off'
    | 'presence_update';
  data?: {
    message?: ChatwootMessage;
    conversation?: ChatwootConversation;
    user?: {name?: string; avatar_url?: string};
  };
};

export type ChatwootWsFrame = {
  identifier?: string;
  message?: ChatwootWsEvent;
  type?: 'confirm_subscription' | 'ping' | 'welcome' | 'reject_subscription';
};
