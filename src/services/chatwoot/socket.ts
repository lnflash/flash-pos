import chatwootConfig from './config';
import type {ChatwootWsEvent, ChatwootWsFrame} from './types';

type SubscriptionCallbacks = {
  onEvent: (event: ChatwootWsEvent) => void;
  onConnect?: () => void;
  onDisconnect?: (error?: unknown) => void;
};

/**
 * Decodes a JWT payload without verification to extract the pubsub_token
 * and account_id needed for the WebSocket subscription.
 */
const decodeJwt = (token: string): Record<string, unknown> => {
  try {
    const payload = token.split('.')[1];
    // JWT uses base64url — convert to base64, pad if needed
    const base64 = payload.replace(/-/g, '+').replace(/_/g, '/');
    const padded = base64 + '==='.slice((base64.length + 3) % 4);
    const json = decodeURIComponent(
      atob(padded)
        .split('')
        .map(c => '%' + ('00' + c.charCodeAt(0).toString(16)).slice(-2))
        .join(''),
    );
    return JSON.parse(json);
  } catch {
    return {};
  }
};

export class ChatwootSocket {
  private ws: WebSocket | null = null;
  private authToken: string;
  private callbacks: SubscriptionCallbacks;
  private shouldReconnect = true;
  private reconnectAttempts = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private subscribedIdentifier: string | null = null;

  constructor(authToken: string, callbacks: SubscriptionCallbacks) {
    this.authToken = authToken;
    this.callbacks = callbacks;
  }

  connect(): void {
    this.shouldReconnect = true;
    this.openSocket();
  }

  private openSocket() {
    try {
      this.ws = new WebSocket(chatwootConfig.wsUrl);
    } catch (err) {
      this.handleDisconnect(err);
      return;
    }

    this.ws.onopen = () => {
      this.reconnectAttempts = 0;
      this.sendSubscribe();
    };

    this.ws.onmessage = (event: WebSocketMessageEvent) => {
      this.handleMessage(event.data);
    };

    this.ws.onerror = (event: Event) => {
      this.handleDisconnect(event);
    };

    this.ws.onclose = () => {
      this.handleDisconnect();
    };
  }

  private sendSubscribe() {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      return;
    }

    // Extract pubsub_token and account_id from the JWT
    const claims = decodeJwt(this.authToken);
    const pubsubToken = claims.pubsub_token as string | undefined;
    const accountId =
      (claims.account_id as number | undefined) ?? chatwootConfig.accountId;

    const identifier = JSON.stringify({
      channel: 'RoomChannel',
      pubsub_token: pubsubToken,
      account_id: accountId,
    });

    this.subscribedIdentifier = identifier;

    this.ws.send(
      JSON.stringify({
        command: 'subscribe',
        identifier,
      }),
    );

    // Notify connected immediately — WS is open and subscribed
    this.callbacks.onConnect?.();
  }

  private handleMessage(rawData: string) {
    let frame: ChatwootWsFrame;

    try {
      frame = JSON.parse(rawData) as ChatwootWsFrame;
    } catch {
      return;
    }

    // Ignore ActionCable protocol messages (ping, welcome, etc.)
    if (!frame.message || typeof frame.message.type !== 'string') {
      return;
    }

    this.callbacks.onEvent(frame.message);
  }

  private handleDisconnect(error?: unknown) {
    if (this.ws) {
      this.ws.onopen = null;
      this.ws.onmessage = null;
      this.ws.onerror = null;
      this.ws.onclose = null;
      this.ws = null;
    }

    this.callbacks.onDisconnect?.(error);

    if (!this.shouldReconnect) {
      return;
    }

    this.reconnectAttempts += 1;
    const delay = Math.min(1000 * Math.pow(2, this.reconnectAttempts), 15000);

    this.reconnectTimer = setTimeout(() => {
      this.openSocket();
    }, delay);
  }

  disconnect(): void {
    this.shouldReconnect = false;

    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    if (this.ws) {
      if (this.subscribedIdentifier && this.ws.readyState === WebSocket.OPEN) {
        this.ws.send(
          JSON.stringify({
            command: 'unsubscribe',
            identifier: this.subscribedIdentifier,
          }),
        );
      }

      this.ws.close();
      this.ws = null;
    }
  }
}
