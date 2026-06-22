/**
 * Tests for the Chatwoot WebSocket (ActionCable) client.
 */

import {ChatwootSocket} from '../../../src/services/chatwoot/socket';

type MockWs = {
  onopen: (() => void) | null;
  onmessage: ((event: {data: string}) => void) | null;
  onerror: ((event: Event) => void) | null;
  onclose: (() => void) | null;
  send: jest.Mock;
  close: jest.Mock;
  readyState: number;
};

const mockSockets: MockWs[] = [];
const OPEN = 1;

class MockWebSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = OPEN;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;

  onopen: (() => void) | null = null;
  onmessage: ((event: {data: string}) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  onclose: (() => void) | null = null;
  send = jest.fn();
  close = jest.fn();
  readyState = MockWebSocket.CONNECTING;

  constructor() {
    mockSockets.push(this);

    setTimeout(() => {
      this.readyState = OPEN;
      this.onopen?.();
    }, 0);
  }
}

global.WebSocket = MockWebSocket as unknown as typeof WebSocket;

describe('ChatwootSocket', () => {
  beforeEach(() => {
    mockSockets.length = 0;
  });

  // Create a JWT with pubsub_token for tests
  const makeJwt = (claims: Record<string, unknown>): string => {
    const header = btoa(JSON.stringify({alg: 'HS256'}));
    // Standard base64 payload (RN atob can decode this)
    const payload = btoa(JSON.stringify(claims));
    return `${header}.${payload}.signature`;
  };

  it('subscribes to RoomChannel with JWT claims on connect', async () => {
    const jwt = makeJwt({
      pubsub_token: 'pub_test_123',
      account_id: 1,
      inbox_id: 1,
    });

    const onEvent = jest.fn();
    const onConnect = jest.fn();
    const socket = new ChatwootSocket(jwt, {onEvent, onConnect});

    socket.connect();
    await new Promise(resolve => setTimeout(resolve, 10));

    expect(onConnect).toHaveBeenCalled();

    const mockWs = mockSockets[mockSockets.length - 1];
    expect(mockWs.send).toHaveBeenCalled();

    const sentData = JSON.parse(mockWs.send.mock.calls[0][0]);
    expect(sentData.command).toBe('subscribe');

    const identifier = JSON.parse(sentData.identifier);
    expect(identifier.channel).toBe('RoomChannel');
    expect(identifier.pubsub_token).toBe('pub_test_123');
    expect(identifier.account_id).toBe(1);
  });

  it('calls onEvent when a message_created frame arrives', async () => {
    const jwt = makeJwt({pubsub_token: 'tok', account_id: 1});
    const onEvent = jest.fn();
    const socket = new ChatwootSocket(jwt, {onEvent});

    socket.connect();
    await new Promise(resolve => setTimeout(resolve, 10));

    const mockWs = mockSockets[mockSockets.length - 1];

    mockWs.onmessage?.({
      data: JSON.stringify({
        identifier: '{"channel":"RoomChannel"}',
        message: {
          type: 'message_created',
          data: {
            message: {
              id: 5,
              content: 'Hello from support',
              message_type: 1,
              created_at: 1700000050,
            },
          },
        },
      }),
    });

    expect(onEvent).toHaveBeenCalledTimes(1);
    const event = onEvent.mock.calls[0][0];
    expect(event.type).toBe('message_created');
    expect(event.data.message.content).toBe('Hello from support');
  });

  it('ignores ActionCable protocol frames', async () => {
    const jwt = makeJwt({pubsub_token: 'tok', account_id: 1});
    const onEvent = jest.fn();
    const socket = new ChatwootSocket(jwt, {onEvent});

    socket.connect();
    await new Promise(resolve => setTimeout(resolve, 10));

    const mockWs = mockSockets[mockSockets.length - 1];

    mockWs.onmessage?.({data: JSON.stringify({type: 'ping', message: {}})});
    mockWs.onmessage?.({data: JSON.stringify({type: 'welcome'})});
    mockWs.onmessage?.({
      data: JSON.stringify({type: 'confirm_subscription'}),
    });

    expect(onEvent).not.toHaveBeenCalled();
  });

  it('ignores malformed JSON gracefully', async () => {
    const jwt = makeJwt({pubsub_token: 'tok', account_id: 1});
    const onEvent = jest.fn();
    const socket = new ChatwootSocket(jwt, {onEvent});

    socket.connect();
    await new Promise(resolve => setTimeout(resolve, 10));

    const mockWs = mockSockets[mockSockets.length - 1];
    mockWs.onmessage?.({data: 'not json'});

    expect(onEvent).not.toHaveBeenCalled();
  });

  it('does not reconnect after explicit disconnect', async () => {
    const jwt = makeJwt({pubsub_token: 'tok', account_id: 1});
    const socket = new ChatwootSocket(jwt, {onEvent: jest.fn()});

    socket.connect();
    await new Promise(resolve => setTimeout(resolve, 10));

    const initialCount = mockSockets.length;
    socket.disconnect();

    await new Promise(resolve => setTimeout(resolve, 50));

    expect(mockSockets.length).toBe(initialCount);
  });
});
