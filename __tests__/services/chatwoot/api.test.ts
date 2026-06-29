/**
 * Test the Chatwoot Widget API client.
 * Verified response shapes from live support.getflash.io:
 *   - POST /conversations → returns conversation object directly (with id, messages[])
 *   - GET /messages → returns { payload: [...] }
 *   - POST /messages → returns message object directly
 */

const mockFetch = jest.fn();
global.fetch = mockFetch as unknown as typeof fetch;

import * as api from '../../../src/services/chatwoot/api';

const WIDGET_HTML = `
<!DOCTYPE html>
<html>
<head><script>window.authToken = 'test.jwt.token';</script></head>
<body></body>
</html>
`;

const jsonOk = (data: unknown) =>
  ({
    ok: true,
    status: 200,
    statusText: 'OK',
    json: async () => data,
    text: async () => (typeof data === 'string' ? data : JSON.stringify(data)),
  }) as Response;

const htmlOk = (html: string) =>
  ({
    ok: true,
    status: 200,
    statusText: 'OK',
    text: async () => html,
    json: async () => ({}),
  }) as Response;

describe('Chatwoot Widget API client', () => {
  beforeEach(() => {
    mockFetch.mockClear();
  });

  describe('initSession', () => {
    it('fetches widget page for auth token then creates conversation with initial message', async () => {
      // 1. Widget HTML
      mockFetch.mockResolvedValueOnce(htmlOk(WIDGET_HTML));
      // 2. Create conversation response — returns conversation object directly
      mockFetch.mockResolvedValueOnce(
        jsonOk({
          id: 42,
          inbox_id: 1,
          status: 'open',
          messages: [
            {
              id: 1,
              content: 'Flash POS v0.3.1 • iOS • iOS 18.4',
              message_type: 0,
              created_at: 1700000000,
            },
          ],
        }),
      );

      const session = await api.initSession('Flash POS (iOS)', 'Flash POS v0.3.1 • iOS • iOS 18.4');

      expect(session.authToken).toBe('test.jwt.token');
      expect(session.conversationId).toBe(42);

      // Verify the conversation creation uses the provided initial message
      const [, convOpts] = mockFetch.mock.calls[1];
      const body = JSON.parse(convOpts.body);
      expect(body.message.content).toBe('Flash POS v0.3.1 • iOS • iOS 18.4');
      expect(body.message.timestamp).toBeTruthy();
      expect(body.contact.name).toBe('Flash POS (iOS)');
    });

    it('throws when widget page does not contain auth token', async () => {
      mockFetch.mockResolvedValueOnce(
        htmlOk('<html><body>No token here</body></html>'),
      );

      await expect(api.initSession()).rejects.toThrow(/authToken not found/);
    });

    it('throws when conversation creation returns 500', async () => {
      mockFetch.mockResolvedValueOnce(htmlOk(WIDGET_HTML));
      mockFetch.mockResolvedValueOnce(
        ({ok: false, status: 500, statusText: 'Internal Server Error', text: async () => '', json: async () => ({})}) as Response,
      );

      await expect(api.initSession()).rejects.toThrow(/Chatwoot API 500/);
    });
  });

  describe('getMessages', () => {
    it('GETs messages and unwraps payload', async () => {
      mockFetch.mockResolvedValueOnce(
        jsonOk({
          payload: [
            {id: 1, content: 'Hello', message_type: 1, created_at: 1700000000},
            {id: 2, content: 'Hi there', message_type: 0, created_at: 1700000010},
          ],
        }),
      );

      const messages = await api.getMessages(42, 'test.jwt.token');

      expect(messages).toHaveLength(2);
      expect(messages[0].content).toBe('Hello');
    });

    it('returns empty array when payload is missing', async () => {
      mockFetch.mockResolvedValueOnce(jsonOk({}));

      const messages = await api.getMessages(42, 'token');

      expect(messages).toEqual([]);
    });
  });

  describe('sendMessage', () => {
    it('POSTs a message and returns the created message', async () => {
      mockFetch.mockResolvedValueOnce(
        jsonOk({
          id: 10,
          content: 'Test message',
          message_type: 0,
          created_at: 1700000020,
          conversation_id: 42,
        }),
      );

      const msg = await api.sendMessage(42, 'token', 'Test message');

      expect(msg.id).toBe(10);
      expect(msg.content).toBe('Test message');

      const [url, opts] = mockFetch.mock.calls[0];
      expect(url).toContain('/api/v1/widget/messages');
      expect(opts.method).toBe('POST');
      expect(opts.headers['X-Auth-Token']).toBe('token');

      const body = JSON.parse(opts.body);
      expect(body.message.content).toBe('Test message');
      expect(body.message.timestamp).toBeTruthy();
    });
  });

  describe('updateLastSeen', () => {
    it('POSTs update without throwing on failure', async () => {
      mockFetch.mockResolvedValueOnce(
        ({ok: false, status: 500, statusText: 'Error', text: async () => '', json: async () => ({})}) as Response,
      );

      await expect(api.updateLastSeen(42, 'token')).resolves.not.toThrow();
    });
  });
});
