import {Platform} from 'react-native';
import {renderHook, waitFor} from '@testing-library/react-native';

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

describe('useSupportChat', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockLoadSession.mockResolvedValue(null);
    mockSaveSession.mockResolvedValue(undefined);
    mockClearSession.mockResolvedValue(undefined);
    mockInitSession.mockResolvedValue(SESSION);
    mockGetMessages.mockResolvedValue([]);
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
    expect(mockSaveSession).toHaveBeenCalledWith(SESSION);
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
    mockLoadSession.mockResolvedValue(SESSION);

    renderHook(() => useSupportChat());

    await waitFor(() =>
      expect(mockGetMessages).toHaveBeenCalledWith(
        SESSION.conversationId,
        SESSION.authToken,
      ),
    );

    expect(mockInitSession).not.toHaveBeenCalled();
    expect(mockSaveSession).not.toHaveBeenCalled();
  });
});
