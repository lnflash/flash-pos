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

const CHATWOOT_HTML = `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
  <title>Flash Support</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: #fff; }
    .loading { display: flex; align-items: center; justify-content: center; height: 100vh; color: #666; font-size: 16px; }
    /* Force Chatwoot widget to fill the screen */
    .woot-widget-holder { position: fixed !important; top: 0 !important; bottom: 0 !important; left: 0 !important; right: 0 !important; max-height: 100vh !important; min-height: 100vh !important; border-radius: 0 !important; }
    .woot--bubble-holder { display: none !important; }
  </style>
</head>
<body>
  <div class="loading" id="loading">Connecting to support...</div>

  <script>
    window.chatwootSettings = {
      position: "right",
      type: "expanded_bubble",
      launcherTitle: "Flash Support"
    };

    (function(d, t) {
      var BASE_URL = "https://app.chatwoot.com/";
      var g = d.createElement(t), s = d.getElementsByTagName(t)[0];
      g.src = BASE_URL + "/packs/js/sdk.js";
      g.async = true;
      s.parentNode.insertBefore(g, s);
      g.onload = function() {
        window.chatwootSDK.run({
          websiteToken: 'iXmsgU54be2SiQvgBg77bn9S',
          baseUrl: BASE_URL
        });
      };
    })(document, "script");

    window.addEventListener('chatwoot:ready', function() {
      document.getElementById('loading').style.display = 'none';
      if (window.$chatwoot) {
        window.$chatwoot.toggle('open');
      }
      window.ReactNativeWebView.postMessage(JSON.stringify({
        type: 'chatReady',
        success: true
      }));
    });
  </script>
</body>
</html>
`;

const SupportChat = () => {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const webViewRef = useRef<any>(null);

  const handleLoadEnd = () => {
    // WebView loaded, Chatwoot SDK will initialize
    setTimeout(() => setLoading(false), 3000); // Fallback timeout
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

      if (data.type === 'chatReady') {
        setLoading(false);
      }
    } catch (e) {
      console.log('Raw WebView message:', event.nativeEvent.data);
    }
  };

  const handleRefresh = () => {
    setError(null);
    setLoading(true);
    webViewRef.current?.reload();
  };

  return (
    <SafeAreaView style={styles.container}>
      {error && (
        <View style={styles.errorContainer}>
          <Text style={styles.errorText}>{error}</Text>
          <TouchableOpacity onPress={handleRefresh} style={styles.retryButton}>
            <Text style={styles.retryButtonText}>Try Again</Text>
          </TouchableOpacity>
        </View>
      )}

      {loading && (
        <View style={styles.loadingOverlay}>
          <ActivityIndicator size="large" color="#007856" />
          <Text style={styles.loadingText}>Loading Support Chat...</Text>
        </View>
      )}

      <WebView
        ref={webViewRef}
        source={{html: CHATWOOT_HTML}}
        style={styles.webview}
        javaScriptEnabled={true}
        domStorageEnabled={true}
        startInLoadingState={false}
        mixedContentMode="compatibility"
        allowsInlineMediaPlayback={true}
        onLoadEnd={handleLoadEnd}
        onError={handleError}
        onMessage={handleMessage}
        scalesPageToFit={false}
        bounces={false}
        scrollEnabled={true}
        webviewDebuggingEnabled={__DEV__}
        originWhitelist={['*']}
      />
    </SafeAreaView>
  );
};

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: 'white',
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
    marginBottom: 70,
  },
});

export default SupportChat;
