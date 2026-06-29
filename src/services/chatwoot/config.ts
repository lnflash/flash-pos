// Chatwoot Widget API configuration for support.getflash.io
//
// This Chatwoot instance uses the Website channel widget API (not the
// Public API channel). The auth flow is:
//   1. GET /widget?website_token=XXX → extracts JWT authToken from HTML
//   2. Use X-Auth-Token header for all subsequent /api/v1/widget/* calls

const BASE_URL = 'https://support.getflash.io';

// Website channel token from Chatwoot admin → Inboxes → Website channel
const WEBSITE_TOKEN = '8J2iDCw5f6dgxGa1UFvP1aww';

export const chatwootConfig = {
  /** Root URL of the self-hosted Chatwoot instance */
  baseUrl: BASE_URL,
  /** Widget API base (website channel) */
  apiBase: `${BASE_URL}/api/v1/widget`,
  /** WebSocket URL for real-time updates (ActionCable) */
  wsUrl: 'wss://support.getflash.io/cable',
  /** Website channel token */
  websiteToken: WEBSITE_TOKEN,
  /** Chatwoot account ID */
  accountId: 1,
} as const;

export default chatwootConfig;
