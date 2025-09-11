import React, {createContext, useEffect, useState} from 'react';
import NfcManager, {Ndef, NfcEvents, TagEvent} from 'react-native-nfc-manager';
import {Platform} from 'react-native';
import {getParams} from 'js-lnurl';
import axios from 'axios';
import AsyncStorage from '@react-native-async-storage/async-storage';
import {ActivityIndicator} from './ActivityIndicator';
import {toastShow} from '../utils/toast';
import {navigationRef} from '../routes';

// Local storage key for stored cards
const STORED_CARDS_KEY = '@flashcard_stored_cards';

interface FlashcardInterface {
  tag?: TagEvent;
  k1?: string;
  callback?: string;
  lnurl?: string;
  balanceInSats?: number;
  transactions?: TransactionList;
  loading?: boolean;
  error?: string;
  isNfcEnabled?: boolean;
  handleTag: (tag: TagEvent) => void;
  resetFlashcard: () => void;
  setNfcEnabled: (enabled: boolean) => void;
  getCardRewardLnurl: () => string | undefined;
  getAllStoredCards: () => Promise<StoredCardInfo[]>;
  deleteStoredCard: (tagId: string) => Promise<boolean>;
  clearAllStoredCards: () => Promise<boolean>;
}

const defaultValue: FlashcardInterface = {
  isNfcEnabled: true,
  handleTag: (tag: TagEvent) => {},
  resetFlashcard: () => {},
  setNfcEnabled: () => {},
  getCardRewardLnurl: () => undefined,
  getAllStoredCards: async () => [],
  deleteStoredCard: async () => false,
  clearAllStoredCards: async () => false,
};

export const FlashcardContext = createContext(defaultValue);

type Props = {
  children: React.ReactNode;
};

export const FlashcardProvider = ({children}: Props) => {
  const [tag, setTag] = useState<TagEvent>();
  const [k1, setK1] = useState<string>();
  const [callback, setCallback] = useState<string>();
  const [lnurl, setLnurl] = useState<string>();
  const [balanceInSats, setBalanceInSats] = useState<number>();
  const [transactions, setTransactions] = useState<TransactionList>();
  const [loading, setLoading] = useState<boolean>();
  const [error, setError] = useState<string>();
  const [isNfcEnabled, setNfcEnabled] = useState<boolean>(true);

  useEffect(() => {
    checkNfc();
  }, []);

  const checkNfc = async () => {
    const isSupported = await NfcManager.isSupported();
    const isEnabled = await NfcManager.isEnabled();

    if (!isSupported) {
      toastShow({
        message: 'NFC is not supported on this device',
        type: 'error',
      });
    } else if (!isEnabled) {
      toastShow({
        message: 'NFC is not enabled on this device.',
        type: 'error',
      });
    }
  };

  const handleTag = async (scannedTag: TagEvent) => {
    // Check if NFC is enabled before processing
    if (!isNfcEnabled) {
      return;
    }

    const currentScreen = navigationRef.getCurrentRoute()?.name;

    if (scannedTag?.id) {
      const ndefRecord = scannedTag?.ndefMessage?.[0];
      if (!ndefRecord) {
        toastShow({message: 'NDEF message not found.', type: 'error'});
      } else {
        setLoading(true);
        const payload = Ndef.text.decodePayload(
          new Uint8Array(ndefRecord.payload),
        );

        if (payload.startsWith('lnurlw')) {
          setTag(scannedTag);
          if (currentScreen === 'Invoice') {
            await getPayDetails(payload, scannedTag);
          } else if (currentScreen === 'Keypad') {
            await getHtml(payload, currentScreen, scannedTag);
          } else if (currentScreen === 'Rewards') {
            await getHtml(payload, currentScreen, scannedTag);
          } else {
            toastShow({
              message:
                'Card scans only work on Keypad, Invoice, and Rewards screens',
              type: 'info',
            });
          }
        }
        setLoading(false);
      }
    } else {
      toastShow({message: 'No tag found', type: 'error'});
    }
  };

  const getPayDetails = async (payload: string, currentTag: TagEvent) => {
    try {
      // First, get the payment details for Lightning payment
      const lnurlParams = await getParams(payload);
      if ('tag' in lnurlParams && lnurlParams.tag === 'withdrawRequest') {
        const {k1: paramK1, callback: paramCallback} = lnurlParams;
        setK1(paramK1);
        setCallback(paramCallback);
      } else {
        toastShow({
          message: `not a properly configured lnurl withdraw tag\n\n${payload}\n\n${
            'reason' in lnurlParams && lnurlParams.reason
          }`,
          type: 'error',
        });
        return;
      }

      // Try to get LNURL from stored card info instead of making another request
      if (currentTag?.id) {
        const storedCardInfo = await getStoredCardInfo(currentTag.id);

        if (storedCardInfo && storedCardInfo.lnurl) {
          setLnurl(storedCardInfo.lnurl);
          if (storedCardInfo.balanceInSats !== undefined) {
            setBalanceInSats(storedCardInfo.balanceInSats);
          }
        } else {
        }
      }
    } catch (err) {
      toastShow({
        message:
          'Unsupported NFC card. Please ensure you are using a flashcard.',
        type: 'error',
      });
    }
  };

  const getHtml = async (
    payload: string,
    currentScreen?: string,
    currentTag?: TagEvent,
  ) => {
    try {
      // Extract the full URL from the payload instead of just the query parameters
      const urlMatch = payload.match(/lnurlw?:\/\/[^?]+/);

      if (!urlMatch) {
        throw new Error('No valid URL found in payload');
      }
      let baseUrl = urlMatch[0].replace(/^lnurlw?:\/\//, 'https://');

      // Convert boltcard endpoint to boltcards/balance endpoint
      if (baseUrl.includes('/boltcard')) {
        baseUrl = baseUrl.replace('/boltcard', '/boltcards/balance');
      }

      const payloadPart = payload.split('?')[1];

      const url = `${baseUrl}?${payloadPart}`;

      const response = await axios.get(url);

      const html = response.data;

      // Extract card information using new helper functions that return values
      const extractedLnurl = getLnurlFromHtml(html);
      const extractedBalance = getBalanceFromHtml(html);
      const extractedTransactions = getTransactionsFromHtml(html);

      // Set state for immediate UI use
      if (extractedLnurl) {
        setLnurl(extractedLnurl);
      }
      if (extractedBalance !== undefined) {
        setBalanceInSats(extractedBalance);
      }
      if (extractedTransactions) {
        setTransactions(extractedTransactions);
      }

      // Store card info immediately for future use (when making payments)
      if (currentTag?.id && extractedLnurl) {
        await storeCardInfo(currentTag.id, extractedLnurl, extractedBalance);

        // Verify storage worked by immediately checking
        const verifyStoredCard = await getStoredCardInfo(currentTag.id);
        if (verifyStoredCard) {
        } else {
        }
      } else {
      }

      if (
        currentScreen !== 'Rewards' &&
        currentScreen !== 'Success' &&
        currentScreen !== 'RewardsSuccess' &&
        navigationRef.isReady()
      ) {
        navigationRef.navigate('FlashcardBalance');
      }
    } catch (err) {
      toastShow({
        message:
          'Unsupported NFC card. Please ensure you are using a flashcard or other boltcard compatible NFC.',
        type: 'error',
      });
    }
  };

  // Helper functions that return values instead of setting state
  const getLnurlFromHtml = (html: string): string | undefined => {
    // Try various LNURL patterns that might appear in the HTML
    const patterns = [
      // Original pattern from working version
      /href="lightning:(lnurl\w+)"/,
      // Alternative patterns
      /lightning:(lnurl[a-zA-Z0-9]+)/,
      /'lightning:(lnurl[a-zA-Z0-9]+)'/,
      /"lightning:(lnurl[a-zA-Z0-9]+)"/,
      // LNURL without lightning prefix
      /(lnurl[a-zA-Z0-9]{50,})/i,
      // In data attributes
      /data-lnurl="(lnurl[a-zA-Z0-9]+)"/,
      // In value attributes
      /value="(lnurl[a-zA-Z0-9]+)"/,
      // Look for any standalone lnurl
      /\b(lnurl[a-zA-Z0-9]+)\b/gi,
    ];

    for (let i = 0; i < patterns.length; i++) {
      const pattern = patterns[i];
      const match = html.match(pattern);

      if (match && match[1]) {
        return match[1];
      }
    }

    // If no patterns match, let's look for any occurrence of 'lnurl' to debug
    const lnurlOccurrences = html.toLowerCase().indexOf('lnurl');
    if (lnurlOccurrences !== -1) {
      const contextStart = Math.max(0, lnurlOccurrences - 50);
      const contextEnd = Math.min(html.length, lnurlOccurrences + 100);
    }

    return undefined;
  };

  const getBalanceFromHtml = (html: string): number | undefined => {
    const balanceMatch = html.match(/(\d{1,3}(?:,\d{3})*)\s*SATS<\/dt>/);
    if (balanceMatch) {
      const parsedBalance = balanceMatch[1].replace(/,/g, '');
      const satoshiAmount = parseInt(parsedBalance, 10);
      return satoshiAmount;
    }
    return undefined;
  };

  const getTransactionsFromHtml = (
    html: string,
  ): TransactionList | undefined => {
    const transactionMatches = [
      ...html.matchAll(
        /<time datetime="(.*?)".*?>.*?<\/time>\s*<\/td>\s*<td.*?>\s*<span.*?>(-?\d{1,3}(,\d{3})*) SATS<\/span>/g,
      ),
    ];
    const data = transactionMatches.map(match => ({
      date: match[1],
      sats: match[2],
    }));
    return data.length > 0 ? data : undefined;
  };

  const resetFlashcard = () => {
    setTag(undefined);
    setK1(undefined);
    setCallback(undefined);
    setLnurl(undefined);
    setBalanceInSats(undefined);
    setTransactions(undefined);
    setLoading(undefined);
    setError(undefined);
  };

  // Card storage functions
  // TODO: Upgrade to Supabase storage later for cloud sync and better management
  const storeCardInfo = async (
    tagId: string,
    cardLnurl: string,
    cardBalanceInSats?: number,
  ) => {
    try {
      // Get existing stored cards
      const existingCardsJson = await AsyncStorage.getItem(STORED_CARDS_KEY);
      const existingCards: StoredCardInfo[] = existingCardsJson
        ? JSON.parse(existingCardsJson)
        : [];

      // Remove any existing entry for this tag ID
      const filteredCards = existingCards.filter(card => card.tagId !== tagId);

      // Add new/updated card info
      const newCardInfo: StoredCardInfo = {
        tagId,
        lnurl: cardLnurl,
        lastSeen: new Date().toISOString(),
        balanceInSats: cardBalanceInSats,
      };

      filteredCards.unshift(newCardInfo); // Add to beginning

      // Keep only the last 50 cards to prevent storage bloat
      const limitedCards = filteredCards.slice(0, 50);

      await AsyncStorage.setItem(
        STORED_CARDS_KEY,
        JSON.stringify(limitedCards),
      );
    } catch (err) {}
  };

  const getStoredCardInfo = async (
    tagId: string,
  ): Promise<StoredCardInfo | null> => {
    try {
      const existingCardsJson = await AsyncStorage.getItem(STORED_CARDS_KEY);
      if (!existingCardsJson) {
        return null;
      }

      const existingCards: StoredCardInfo[] = JSON.parse(existingCardsJson);
      const foundCard = existingCards.find(card => card.tagId === tagId);

      if (foundCard) {
        return foundCard;
      } else {
        return null;
      }
    } catch (err) {
      return null;
    }
  };

  const getAllStoredCards = async (): Promise<StoredCardInfo[]> => {
    try {
      const existingCardsJson = await AsyncStorage.getItem(STORED_CARDS_KEY);
      if (!existingCardsJson) {
        return [];
      }

      const existingCards: StoredCardInfo[] = JSON.parse(existingCardsJson);
      return existingCards;
    } catch (err) {
      return [];
    }
  };

  const deleteStoredCard = async (tagId: string): Promise<boolean> => {
    try {
      const existingCardsJson = await AsyncStorage.getItem(STORED_CARDS_KEY);
      if (!existingCardsJson) {
        return false;
      }

      const existingCards: StoredCardInfo[] = JSON.parse(existingCardsJson);
      const filteredCards = existingCards.filter(card => card.tagId !== tagId);

      await AsyncStorage.setItem(
        STORED_CARDS_KEY,
        JSON.stringify(filteredCards),
      );
      return true;
    } catch (err) {
      return false;
    }
  };

  const clearAllStoredCards = async (): Promise<boolean> => {
    try {
      await AsyncStorage.removeItem(STORED_CARDS_KEY);
      return true;
    } catch (err) {
      return false;
    }
  };

  if (Platform.OS !== 'ios') {
    NfcManager.setEventListener(NfcEvents.DiscoverTag, handleTag);

    NfcManager.setEventListener(NfcEvents.SessionClosed, () => {
      NfcManager.cancelTechnologyRequest();
      NfcManager.unregisterTagEvent();
    });

    NfcManager.registerTagEvent();
  }
  const getCardRewardLnurl = () => {
    // Return the LNURL that can receive rewards
    return lnurl;
  };

  const value = {
    tag,
    k1,
    callback,
    lnurl,
    balanceInSats,
    transactions,
    loading,
    error,
    isNfcEnabled,
    handleTag,
    resetFlashcard,
    setNfcEnabled,
    getCardRewardLnurl,
    getAllStoredCards,
    deleteStoredCard,
    clearAllStoredCards,
  };

  return (
    <FlashcardContext.Provider value={value}>
      {children}
      {loading && <ActivityIndicator />}
    </FlashcardContext.Provider>
  );
};
