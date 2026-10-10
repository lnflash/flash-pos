import {Platform} from 'react-native';
import {act, renderHook, waitFor} from '@testing-library/react-native';

import {useSupportChat} from '../../src/hooks/useSupportChat';
import pkg from '../../package.json';

const mockLoadSession = jest.fn();
const mockSaveSession = jest.fn();
const mockClearSession = jest.fn();
const mockInitSession = jest.fn();
const mockGetMessages = jest.fn();
const mockSendMessage = jest.fn();
const mockUpdateLastSeen = jest.fn();
const mockSocketConnect = jest.fn();
const mockSocketDisconnect = jest.fn();

jest.mock('../../src/services/chatwoot/storage', () => ({
  loadSession: (...args: unknown[]) => mockLoadSession(...args),
  saveSession: (...args: unknown[]) => mockSaveSession(...args),
  clearSession: (...args: unknown[]) => mockClearSession(...args),
}));

jest.mock('../../src/services/chatwoot/api', () => ({
  initSession: (...args: unknown[]) => mockInitSession(...args),
  getMessages: (...args: unknown[]) => mockGetMessages(...args),
  sendMessage: (...args: unknown[]) => mockSendMessage(...args),
  updateLastSeen: (...args: unknown[]) => mockUpdateLastSeen(...args),
}));

jest.mock('../../src/services/chatwoot/socket', () => ({
  ChatwootSocket: jest.fn().mockImplementation(() => ({
    connect: mockSocketConnect,
    disconnect: mockSocketDisconnect,
  })),
}));

const SESSION = {authToken: 'tok', conversationId: 42};
const CURRENT_SESSION = {...SESSION, appVersion: pkg.version};
const SENT_MESSAGE = {id: 7, content: 'x', message_type: 0, created_at: 1};

describe('useSupportChat', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockLoadSession.mockResolvedValue(null);
    mockSaveSession.mockResolvedValue(undefined);
    mockClearSession.mockResolvedValue(undefined);
    mockInitSession.mockResolvedValue(SESSION);
    mockGetMessages.mockResolvedValue([]);
    mockSendMessage.mockResolvedValue(SENT_MESSAGE);
    mockUpdateLastSeen.mockResolvedValue(undefined);
  });

  it('opens a new session with the package.json version in the device line', async () => {
    renderHook(() => useSupportChat());

    await waitFor(() => expect(mockInitSession).toHaveBeenCalledTimes(1));

    const [contactName, initialMessage] = mockInitSession.mock.calls[0] as [
      string,
      string,
    ];
    expect(contactName).toBe(`Flash POS (${Platform.OS})`);
    expect(initialMessage).toContain(`Flash POS v${pkg.version}`);
    expect(initialMessage).not.toContain('v0.3.1');
    expect(mockSaveSession).toHaveBeenCalledWith(CURRENT_SESSION);
    expect(mockSendMessage).not.toHaveBeenCalled();
  });

  it('prefixes the device line with the merchant when a display name is given', async () => {
    renderHook(() =>
      useSupportChat({
        userIdentifier: 'alice',
        userDisplayName: 'POS — alice',
      }),
    );

    await waitFor(() => expect(mockInitSession).toHaveBeenCalledTimes(1));

    const [contactName, initialMessage] = mockInitSession.mock.calls[0] as [
      string,
      string,
    ];
    expect(contactName).toBe('POS — alice');
    expect(initialMessage).toContain('Merchant: POS — alice\n');
    expect(initialMessage).toContain(`Flash POS v${pkg.version}`);
  });

  it('reuses a stored session without re-sending the device line', async () => {
    mockLoadSession.mockResolvedValue(CURRENT_SESSION);

    renderHook(() => useSupportChat());

    await waitFor(() =>
      expect(mockGetMessages).toHaveBeenCalledWith(
        SESSION.conversationId,
        SESSION.authToken,
      ),
    );

    expect(mockInitSession).not.toHaveBeenCalled();
    expect(mockSendMessage).not.toHaveBeenCalled();
    expect(mockSaveSession).not.toHaveBeenCalled();
  });

  it('sends nothing on mount for a legacy session with no appVersion', async () => {
    mockLoadSession.mockResolvedValue(SESSION);

    const {result} = renderHook(() => useSupportChat());

    await waitFor(() =>
      expect(mockGetMessages).toHaveBeenCalledWith(
        SESSION.conversationId,
        SESSION.authToken,
      ),
    );

    // Opening the tab must not wake the conversation: Chatwoot reopens a
    // resolved ticket on any incoming contact message.
    expect(mockInitSession).not.toHaveBeenCalled();
    expect(mockSendMessage).not.toHaveBeenCalled();
    expect(mockSaveSession).not.toHaveBeenCalled();
    expect(result.current.error).toBeNull();
  });

  it('sends nothing on mount when the stored appVersion is older', async () => {
    mockLoadSession.mockResolvedValue({...SESSION, appVersion: '0.3.1'});

    renderHook(() => useSupportChat());

    await waitFor(() =>
      expect(mockGetMessages).toHaveBeenCalledWith(
        SESSION.conversationId,
        SESSION.authToken,
      ),
    );

    expect(mockInitSession).not.toHaveBeenCalled();
    expect(mockSendMessage).not.toHaveBeenCalled();
    expect(mockSaveSession).not.toHaveBeenCalled();
  });

  it('announces the current version right before the first message on a stale session', async () => {
    mockLoadSession.mockResolvedValue({...SESSION, appVersion: '0.3.1'});

    const {result} = renderHook(() =>
      useSupportChat({
        userIdentifier: 'alice',
        userDisplayName: 'POS — alice',
      }),
    );

    await waitFor(() =>
      expect(mockGetMessages).toHaveBeenCalledWith(
        SESSION.conversationId,
        SESSION.authToken,
      ),
    );
    expect(mockSendMessage).not.toHaveBeenCalled();

    await act(async () => {
      await result.current.sendMessage('hello');
    });

    expect(mockSendMessage).toHaveBeenCalledTimes(2);

    const [conversationId, authToken, content] = mockSendMessage.mock
      .calls[0] as [number, string, string];
    expect(conversationId).toBe(SESSION.conversationId);
    expect(authToken).toBe(SESSION.authToken);
    expect(content).toContain('🔄 App updated');
    expect(content).toContain('Merchant: POS — alice\n');
    expect(content).toContain(`Flash POS v${pkg.version}`);
    expect(content).not.toContain('v0.3.1');

    expect(mockSendMessage).toHaveBeenLastCalledWith(
      SESSION.conversationId,
      SESSION.authToken,
      'hello',
    );
    expect(mockSaveSession).toHaveBeenCalledTimes(1);
    expect(mockSaveSession).toHaveBeenCalledWith(CURRENT_SESSION);
    expect(result.current.error).toBeNull();

    // Stamp is now current: the next message goes out alone.
    await act(async () => {
      await result.current.sendMessage('again');
    });
    expect(mockSendMessage).toHaveBeenCalledTimes(3);
    expect(mockSendMessage).toHaveBeenLastCalledWith(
      SESSION.conversationId,
      SESSION.authToken,
      'again',
    );
    expect(mockSaveSession).toHaveBeenCalledTimes(1);
  });

  it('announces before the first message on a legacy session with no appVersion', async () => {
    mockLoadSession.mockResolvedValue(SESSION);

    const {result} = renderHook(() => useSupportChat());

    await waitFor(() =>
      expect(mockGetMessages).toHaveBeenCalledWith(
        SESSION.conversationId,
        SESSION.authToken,
      ),
    );

    await act(async () => {
      await result.current.sendMessage('hello');
    });

    expect(mockSendMessage).toHaveBeenCalledTimes(2);
    const [, , content] = mockSendMessage.mock.calls[0] as [
      number,
      string,
      string,
    ];
    expect(content).toContain(`Flash POS v${pkg.version}`);
    expect(mockSendMessage).toHaveBeenLastCalledWith(
      SESSION.conversationId,
      SESSION.authToken,
      'hello',
    );
    expect(mockSaveSession).toHaveBeenCalledWith(CURRENT_SESSION);
  });

  it('does not announce on a session already stamped with the current version', async () => {
    mockLoadSession.mockResolvedValue(CURRENT_SESSION);

    const {result} = renderHook(() => useSupportChat());

    await waitFor(() =>
      expect(mockGetMessages).toHaveBeenCalledWith(
        SESSION.conversationId,
        SESSION.authToken,
      ),
    );

    await act(async () => {
      await result.current.sendMessage('hello');
    });

    expect(mockSendMessage).toHaveBeenCalledTimes(1);
    expect(mockSendMessage).toHaveBeenCalledWith(
      SESSION.conversationId,
      SESSION.authToken,
      'hello',
    );
    expect(mockSaveSession).not.toHaveBeenCalled();
  });

  it('keeps the old appVersion and still sends the message when the announce fails', async () => {
    mockLoadSession.mockResolvedValue({...SESSION, appVersion: '0.3.1'});
    mockSendMessage
      .mockRejectedValueOnce(new Error('Network request failed'))
      .mockResolvedValueOnce(SENT_MESSAGE);

    const {result} = renderHook(() => useSupportChat());

    await waitFor(() =>
      expect(mockGetMessages).toHaveBeenCalledWith(
        SESSION.conversationId,
        SESSION.authToken,
      ),
    );

    await act(async () => {
      await result.current.sendMessage('hello');
    });

    expect(mockSendMessage).toHaveBeenCalledTimes(2);
    expect(mockSendMessage).toHaveBeenLastCalledWith(
      SESSION.conversationId,
      SESSION.authToken,
      'hello',
    );
    expect(mockSaveSession).not.toHaveBeenCalled();
    expect(mockClearSession).not.toHaveBeenCalled();
    expect(result.current.error).toBeNull();
    expect(result.current.messages).toEqual([SENT_MESSAGE]);

    // Old stamp kept: the next send retries the announce.
    await act(async () => {
      await result.current.sendMessage('again');
    });
    expect(mockSendMessage).toHaveBeenCalledTimes(4);
    expect(mockSaveSession).toHaveBeenCalledWith(CURRENT_SESSION);
  });

  it('surfaces an auth error from the announce without sending the message', async () => {
    mockLoadSession.mockResolvedValue({...SESSION, appVersion: '0.3.1'});
    mockSendMessage.mockRejectedValueOnce(new Error('Chatwoot API 401: nope'));

    const {result} = renderHook(() => useSupportChat());

    await waitFor(() =>
      expect(mockGetMessages).toHaveBeenCalledWith(
        SESSION.conversationId,
        SESSION.authToken,
      ),
    );

    await act(async () => {
      await result.current.sendMessage('hello');
    });

    expect(mockSendMessage).toHaveBeenCalledTimes(1);
    expect(mockSaveSession).not.toHaveBeenCalled();
    expect(result.current.error).toBe('Chatwoot API 401: nope');
    expect(result.current.isSending).toBe(false);
  });

  it('clears the session when history load hits an auth error', async () => {
    mockLoadSession.mockResolvedValue(CURRENT_SESSION);
    mockGetMessages.mockRejectedValueOnce(new Error('Chatwoot API 404: gone'));

    const {result} = renderHook(() => useSupportChat());

    await waitFor(() => expect(mockClearSession).toHaveBeenCalledTimes(1));

    expect(mockSendMessage).not.toHaveBeenCalled();
    expect(result.current.connectionStatus).toBe('error');
  });

  it('does not clear the session on a non-auth history failure', async () => {
    mockLoadSession.mockResolvedValue(CURRENT_SESSION);
    mockGetMessages.mockRejectedValueOnce(new Error('Network request failed'));

    const {result} = renderHook(() => useSupportChat());

    await waitFor(() => expect(result.current.connectionStatus).toBe('error'));

    expect(mockClearSession).not.toHaveBeenCalled();
  });
});
