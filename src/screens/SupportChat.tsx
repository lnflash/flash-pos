import React, {useRef, useState, useCallback, useEffect} from 'react';
import {
  SafeAreaView,
  View,
  Text,
  TextInput,
  TouchableOpacity,
  FlatList,
  KeyboardAvoidingView,
  Platform,
  ActivityIndicator,
  StyleSheet,
} from 'react-native';
import {useSafeAreaInsets} from 'react-native-safe-area-context';
import {useAppSelector} from '../store/hooks';
import {useSupportChat} from '../hooks/useSupportChat';
import type {ChatwootMessage} from '../services/chatwoot/types';

const BUBBLE_OUTGOING = '#41AC48';
const BUBBLE_INCOMING = '#F0F2F5';
const TEXT_OUTGOING = '#FFFFFF';
const TEXT_INCOMING = '#1A1A1A';
const TIME_OUTGOING = 'rgba(255,255,255,0.7)';
const TIME_INCOMING = '#888888';
const APP_VERSION = '0.3.1';

type RenderMessageProps = {
  item: ChatwootMessage;
};

const isOutgoing = (item: ChatwootMessage) =>
  item.message_type === 0; // 0 = from contact (user), 1 = from agent

const formatTime = (timestamp: number): string => {
  const date = new Date(timestamp * 1000);
  const hours = date.getHours().toString().padStart(2, '0');
  const minutes = date.getMinutes().toString().padStart(2, '0');
  return `${hours}:${minutes}`;
};

const MessageBubble = ({item}: RenderMessageProps) => {
  const outgoing = isOutgoing(item);

  return (
    <View
      style={[
        styles.bubbleRow,
        outgoing ? styles.bubbleRowOutgoing : styles.bubbleRowIncoming,
      ]}>
      <View
        style={[
          styles.bubble,
          {backgroundColor: outgoing ? BUBBLE_OUTGOING : BUBBLE_INCOMING},
        ]}>
        <Text
          style={[
            styles.bubbleText,
            {color: outgoing ? TEXT_OUTGOING : TEXT_INCOMING},
          ]}>
          {item.content}
        </Text>
        <Text
          style={[
            styles.bubbleTime,
            {color: outgoing ? TIME_OUTGOING : TIME_INCOMING},
          ]}>
          {formatTime(item.created_at)}
        </Text>
      </View>
    </View>
  );
};

const ConnectionBanner = ({
  status,
}: {
  status: 'connecting' | 'connected' | 'disconnected' | 'error';
}) => {
  if (status === 'connected') {
    return null;
  }

  const config = {
    connecting: {text: 'Connecting...', color: '#8a8a8a', bg: '#f5f5f5'},
    disconnected: {text: 'Disconnected — retrying...', color: '#8a6d3b', bg: '#fcf8e3'},
    error: {text: 'Connection error', color: '#a94442', bg: '#f2dede'},
  }[status];

  return (
    <View style={[styles.banner, {backgroundColor: config.bg}]}>
      <Text style={[styles.bannerText, {color: config.color}]}>
        {config.text}
      </Text>
    </View>
  );
};

const SupportChat = () => {
  const insets = useSafeAreaInsets();
  const username = useAppSelector(state => state.user.username);
  const {messages, connectionStatus, error, sendMessage, retry, isSending} =
    useSupportChat({
      userIdentifier: username,
      userDisplayName: username ? `POS — ${username}` : undefined,
      appVersion: APP_VERSION,
    });

  const [inputText, setInputText] = useState('');
  const flatListRef = useRef<FlatList<ChatwootMessage>>(null);

  const handleSend = useCallback(() => {
    if (!inputText.trim() || isSending) {
      return;
    }

    const text = inputText;
    setInputText('');
    sendMessage(text);
  }, [inputText, isSending, sendMessage]);

  // Scroll to bottom when new messages arrive
  useEffect(() => {
    if (messages.length > 0) {
      const timer = setTimeout(() => {
        flatListRef.current?.scrollToEnd({animated: true});
      }, 100);
      return () => clearTimeout(timer);
    }
  }, [messages.length]);

  const renderMessage = useCallback(
    ({item}: {item: ChatwootMessage}) => <MessageBubble item={item} />,
    [],
  );

  // Error state with retry
  if (error && messages.length === 0) {
    return (
      <SafeAreaView style={styles.container}>
        <View style={styles.emptyState}>
          <Text style={styles.emptyTitle}>Unable to load support chat</Text>
          <Text style={styles.emptySubtitle}>{error}</Text>
          <TouchableOpacity style={styles.retryButton} onPress={retry}>
            <Text style={styles.retryButtonText}>Try Again</Text>
          </TouchableOpacity>
        </View>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.container}>
      <ConnectionBanner status={connectionStatus} />

      <KeyboardAvoidingView
        style={styles.flex}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        keyboardVerticalOffset={insets.top + 44}>
        <FlatList
          ref={flatListRef}
          data={messages}
          keyExtractor={item => item.id.toString()}
          renderItem={renderMessage}
          contentContainerStyle={styles.messageList}
          onContentSizeChange={() =>
            flatListRef.current?.scrollToEnd({animated: false})
          }
          ListEmptyComponent={
            connectionStatus === 'connecting' ? (
              <View style={styles.emptyState}>
                <ActivityIndicator size="large" color={BUBBLE_OUTGOING} />
                <Text style={styles.emptySubtitle}>
                  Loading support chat...
                </Text>
              </View>
            ) : (
              <View style={styles.emptyState}>
                <Text style={styles.emptyTitle}>No messages yet</Text>
                <Text style={styles.emptySubtitle}>
                  Send a message to start a conversation with our support team.
                </Text>
              </View>
            )
          }
        />

        {/* Input bar */}
        <View
          style={[styles.inputBar, {paddingBottom: insets.bottom || 8}]}>
          <TextInput
            style={styles.textInput}
            placeholder="Type a message..."
            placeholderTextColor="#999"
            value={inputText}
            onChangeText={setInputText}
            multiline
            maxLength={2000}
            editable={connectionStatus !== 'error'}
            accessible
            accessibilityLabel="Support chat message input"
          />
          <TouchableOpacity
            style={[
              styles.sendButton,
              (!inputText.trim() || isSending) && styles.sendButtonDisabled,
            ]}
            onPress={handleSend}
            disabled={!inputText.trim() || isSending}
            accessible
            accessibilityLabel="Send message">
            {isSending ? (
              <ActivityIndicator size="small" color="#fff" />
            ) : (
              <Text style={styles.sendButtonText}>Send</Text>
            )}
          </TouchableOpacity>
        </View>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
};

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#FFFFFF',
  },
  flex: {
    flex: 1,
  },
  banner: {
    paddingVertical: 8,
    paddingHorizontal: 16,
    alignItems: 'center',
  },
  bannerText: {
    fontSize: 13,
    fontFamily: 'Outfit-Regular',
  },
  messageList: {
    paddingHorizontal: 16,
    paddingVertical: 12,
    flexGrow: 1,
  },
  bubbleRow: {
    flexDirection: 'row',
    marginBottom: 8,
    maxWidth: '80%',
  },
  bubbleRowOutgoing: {
    alignSelf: 'flex-end',
    justifyContent: 'flex-end',
  },
  bubbleRowIncoming: {
    alignSelf: 'flex-start',
  },
  bubble: {
    borderRadius: 16,
    paddingHorizontal: 14,
    paddingVertical: 10,
  },
  bubbleText: {
    fontSize: 15,
    fontFamily: 'Outfit-Regular',
    lineHeight: 20,
  },
  bubbleTime: {
    fontSize: 11,
    fontFamily: 'Outfit-Regular',
    marginTop: 4,
    alignSelf: 'flex-end',
  },
  inputBar: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    paddingHorizontal: 12,
    paddingTop: 8,
    paddingBottom: 8,
    borderTopWidth: 1,
    borderTopColor: '#E5E5E5',
    backgroundColor: '#FFFFFF',
  },
  textInput: {
    flex: 1,
    minHeight: 40,
    maxHeight: 100,
    borderRadius: 20,
    backgroundColor: '#F5F5F5',
    paddingHorizontal: 16,
    paddingTop: 10,
    paddingBottom: 10,
    fontSize: 15,
    fontFamily: 'Outfit-Regular',
    color: '#1A1A1A',
    marginRight: 8,
  },
  sendButton: {
    backgroundColor: BUBBLE_OUTGOING,
    borderRadius: 20,
    paddingHorizontal: 20,
    paddingVertical: 10,
    minHeight: 40,
    justifyContent: 'center',
    alignItems: 'center',
  },
  sendButtonDisabled: {
    opacity: 0.5,
  },
  sendButtonText: {
    color: '#FFFFFF',
    fontSize: 15,
    fontFamily: 'Outfit-SemiBold',
  },
  emptyState: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    paddingVertical: 60,
    paddingHorizontal: 32,
  },
  emptyTitle: {
    fontSize: 17,
    fontFamily: 'Outfit-SemiBold',
    color: '#333',
    marginBottom: 8,
    textAlign: 'center',
  },
  emptySubtitle: {
    fontSize: 14,
    fontFamily: 'Outfit-Regular',
    color: '#888',
    textAlign: 'center',
    marginBottom: 16,
  },
  retryButton: {
    backgroundColor: BUBBLE_OUTGOING,
    borderRadius: 8,
    paddingHorizontal: 24,
    paddingVertical: 12,
    marginTop: 8,
  },
  retryButtonText: {
    color: '#FFFFFF',
    fontSize: 15,
    fontFamily: 'Outfit-SemiBold',
  },
});

export default SupportChat;
