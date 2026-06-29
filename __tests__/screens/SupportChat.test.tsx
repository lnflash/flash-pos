import React from 'react';
import {act} from '@testing-library/react-native';
import {render, fireEvent} from '@testing-library/react-native';
import {Provider} from 'react-redux';
import {configureStore} from '@reduxjs/toolkit';
import SupportChat from '../../src/screens/SupportChat';
import rootReducer from '../../src/store/reducers';

// --- Mock the hook so screen tests don't need to orchestrate the full async chain ---

const mockUseSupportChat = jest.fn();

jest.mock('../../src/hooks/useSupportChat', () => ({
  useSupportChat: (...args: unknown[]) => mockUseSupportChat(...args),
}));

jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({top: 0, bottom: 0, left: 0, right: 0}),
}));

const renderSupportChat = () => {
  const store = configureStore({reducer: rootReducer});

  return render(
    <Provider store={store}>
      <SupportChat />
    </Provider>,
  );
};

const seedHook = (overrides: Record<string, unknown> = {}) => {
  mockUseSupportChat.mockReturnValue({
    messages: [],
    connectionStatus: 'connecting',
    error: null,
    sendMessage: jest.fn(),
    retry: jest.fn(),
    isSending: false,
    ...overrides,
  });
};

describe('SupportChat (native)', () => {
  beforeEach(() => {
    mockUseSupportChat.mockReset();
  });

  it('renders the loading state while initializing', () => {
    seedHook({connectionStatus: 'connecting', messages: []});

    const {getByText} = renderSupportChat();

    expect(getByText('Loading support chat...')).toBeTruthy();
  });

  it('shows empty state after connecting with no messages', () => {
    seedHook({connectionStatus: 'connected', messages: []});

    const {getByText} = renderSupportChat();

    expect(getByText('No messages yet')).toBeTruthy();
    expect(
      getByText('Send a message to start a conversation with our support team.'),
    ).toBeTruthy();
  });

  it('shows an error state when the API fails', () => {
    seedHook({
      connectionStatus: 'error',
      error: 'Network error',
      messages: [],
    });

    const {getByText} = renderSupportChat();

    expect(getByText('Unable to load support chat')).toBeTruthy();
    expect(getByText('Network error')).toBeTruthy();
  });

  it('renders the retry button on error and calls retry on press', () => {
    const mockRetry = jest.fn();
    seedHook({
      connectionStatus: 'error',
      error: 'Network error',
      messages: [],
      retry: mockRetry,
    });

    const {getByText} = renderSupportChat();

    fireEvent.press(getByText('Try Again'));
    expect(mockRetry).toHaveBeenCalledTimes(1);
  });

  it('renders messages from history', () => {
    seedHook({
      connectionStatus: 'connected',
      messages: [
        {
          id: 1,
          content: 'Welcome to Flash Support',
          message_type: 1,
          created_at: 1700000000,
        },
        {
          id: 2,
          content: 'How can I help?',
          message_type: 0,
          created_at: 1700000010,
        },
      ],
    });

    const {getByText} = renderSupportChat();

    expect(getByText('Welcome to Flash Support')).toBeTruthy();
    expect(getByText('How can I help?')).toBeTruthy();
  });

  it('sends a message when the send button is pressed', () => {
    const mockSendMessage = jest.fn().mockResolvedValue(undefined);
    seedHook({
      connectionStatus: 'connected',
      messages: [],
      sendMessage: mockSendMessage,
    });

    const {getByLabelText} = renderSupportChat();

    const input = getByLabelText('Support chat message input');
    fireEvent.changeText(input, 'Hello support!');

    const sendButton = getByLabelText('Send message');
    act(() => {
      fireEvent.press(sendButton);
    });

    expect(mockSendMessage).toHaveBeenCalledWith('Hello support!');
  });

  it('disables the send button when input is empty', () => {
    seedHook({connectionStatus: 'connected', messages: []});

    const {getByLabelText} = renderSupportChat();

    const sendButton = getByLabelText('Send message');
    expect(sendButton.props.accessibilityState?.disabled).toBe(true);
  });

  it('shows a disconnected banner', () => {
    seedHook({connectionStatus: 'disconnected', messages: []});

    const {getByText} = renderSupportChat();

    expect(getByText('Disconnected — retrying...')).toBeTruthy();
  });
});
