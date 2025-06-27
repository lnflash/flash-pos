import React, {useState, useRef} from 'react';
import {WebView, WebViewMessageEvent} from 'react-native-webview';
import {
  SafeAreaView,
  ActivityIndicator,
  View,
  Text,
  TouchableOpacity,
  StyleSheet,
} from 'react-native';

const SupportChat = () => {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [chatReady, setChatReady] = useState(false);
  const webViewRef = useRef<any>(null);

  const chatUrl = 'https://nodirbek75.github.io/tidio-widget/tidio.html';

  const handleLoadStart = () => {
    console.log('WebView started loading');
    setLoading(true);
    setError(null);
    setChatReady(false);
  };

  const handleLoadEnd = () => {
    console.log('WebView finished loading');
    setLoading(false);

    // Inject additional JavaScript to ensure chat opens
    const injectJS = `
      console.log('Injecting chat opening script...');
      
      let attempts = 0;
      const maxAttempts = 20;
      
      function forceOpenChat() {
        attempts++;
        console.log('Attempt to open chat:', attempts);
        
        if (window.tidioChatApi) {
          console.log('Tidio API found, opening chat...');
          try {
            window.tidioChatApi.open();
            window.ReactNativeWebView.postMessage(JSON.stringify({
              type: 'chatOpened',
              success: true
            }));
            return true;
          } catch (error) {
            console.error('Error opening chat:', error);
            window.ReactNativeWebView.postMessage(JSON.stringify({
              type: 'chatError',
              error: error.message
            }));
          }
        }
        
        if (attempts < maxAttempts) {
          setTimeout(forceOpenChat, 500);
        } else {
          console.error('Failed to open chat after', maxAttempts, 'attempts');
          window.ReactNativeWebView.postMessage(JSON.stringify({
            type: 'chatTimeout',
            attempts: attempts
          }));
        }
        
        return false;
      }
      
      // Try multiple approaches
      setTimeout(forceOpenChat, 1000);
      
      // Also listen for the ready event
      document.addEventListener('tidioChat-ready', function() {
        console.log('Tidio ready event received in injected script');
        setTimeout(() => {
          if (window.tidioChatApi) {
            window.tidioChatApi.open();
            window.ReactNativeWebView.postMessage(JSON.stringify({
              type: 'chatReady',
              success: true
            }));
          }
        }, 500);
      });
      
      // Send status update
      window.ReactNativeWebView.postMessage(JSON.stringify({
        type: 'scriptInjected',
        timestamp: new Date().toISOString()
      }));
      
      true; // Return true to indicate successful injection
    `;

    webViewRef.current?.injectJavaScript(injectJS);
  };

  const handleError = (syntheticEvent: any) => {
    const {nativeEvent} = syntheticEvent;
    console.error('WebView error:', nativeEvent);
    setLoading(false);
    setError(`Failed to load chat: ${nativeEvent.description}`);
  };

  const handleMessage = (event: WebViewMessageEvent) => {
    try {
      const data = JSON.parse(event.nativeEvent?.data);
      console.log('Message from WebView:', data);

      switch (data.type) {
        case 'chatOpened':
          setChatReady(true);
          console.log('Chat opened successfully');
          break;
        case 'chatReady':
          setChatReady(true);
          console.log('Chat is ready');
          break;
        case 'chatError':
          console.error('Chat error:', data.error);
          setError(`Chat error: ${data.error}`);
          break;
        case 'chatTimeout':
          console.error('Chat timeout after', data.attempts, 'attempts');
          setError('Chat failed to load. Please try refreshing.');
          break;
        case 'scriptInjected':
          console.log('Script injected at:', data.timestamp);
          break;
        default:
          console.log('Unknown message type:', data.type);
      }
    } catch (e) {
      console.log('Raw WebView message:', event.nativeEvent.data);
    }
  };

  const handleRefresh = () => {
    setError(null);
    setLoading(true);
    setChatReady(false);
    webViewRef.current?.reload();
  };

  return (
    <SafeAreaView style={styles.container}>
      {/* Error display */}
      {error && (
        <View style={styles.errorContainer}>
          <Text style={styles.errorText}>{error}</Text>
          <TouchableOpacity onPress={handleRefresh} style={styles.retryButton}>
            <Text style={styles.retryButtonText}>Try Again</Text>
          </TouchableOpacity>
        </View>
      )}

      {/* Loading overlay */}
      {loading && (
        <View style={styles.loadingOverlay}>
          <ActivityIndicator size="large" color="#007856" />
          <Text style={styles.loadingText}>Loading Tidio Chat...</Text>
        </View>
      )}

      {/* WebView */}
      <WebView
        ref={webViewRef}
        source={{uri: chatUrl}}
        style={styles.webview}
        javaScriptEnabled={true}
        domStorageEnabled={true}
        startInLoadingState={false} // We handle loading manually
        mixedContentMode="compatibility"
        allowsInlineMediaPlaybook={true}
        mediaPlaybackRequiresUserAction={false}
        onLoadStart={handleLoadStart}
        onLoadEnd={handleLoadEnd}
        onError={handleError}
        onMessage={handleMessage}
        scalesPageToFit={false}
        bounces={false}
        scrollEnabled={true}
        allowsBackForwardNavigationGestures={false}
        webviewDebuggingEnabled={__DEV__}
        userAgent="Mozilla/5.0 (iPhone; CPU iPhone OS 14_0 like Mac OS X) AppleWebKit/605.1.15"
      />
    </SafeAreaView>
  );
};

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: 'white',
    paddingBottom: 70,
  },
  errorContainer: {
    backgroundColor: '#f8d7da',
    padding: 15,
    borderBottomWidth: 1,
    borderBottomColor: '#f5c6cb',
    alignItems: 'center',
  },
  errorText: {
    color: '#721c24',
    fontSize: 14,
    fontFamily: 'Outfit-Regular',
    textAlign: 'center',
    marginBottom: 10,
  },
  retryButton: {
    backgroundColor: '#dc3545',
    paddingHorizontal: 15,
    paddingVertical: 8,
    borderRadius: 5,
  },
  retryButtonText: {
    color: 'white',
    fontSize: 14,
    fontWeight: '600',
  },
  loadingOverlay: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: 'rgba(255, 255, 255, 0.9)',
    justifyContent: 'center',
    alignItems: 'center',
    zIndex: 1000,
  },
  loadingText: {
    marginTop: 15,
    fontSize: 16,
    fontFamily: 'Outfit-Bold',
    color: '#666',
    textAlign: 'center',
  },
  webview: {
    flex: 1,
  },
});

export default SupportChat;
