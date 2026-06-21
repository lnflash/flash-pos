import React, {createContext, useEffect, useRef, useState} from 'react';
import NfcManager, {Ndef, NfcEvents, TagEvent} from 'react-native-nfc-manager';
import {Platform} from 'react-native';
import {getParams} from 'js-lnurl';
import axios from 'axios';
import {ActivityIndicator} from './ActivityIndicator';
import {toastShow} from '../utils/toast';
import {navigationRef} from '../routes';
import {isRewardsEnabled} from '../utils/featureFlags';
import {
  getBalanceFromHtml,
  getLnurlFromHtml,
  getTransactionsFromHtml,
} from '../utils/flashcardParser';
import {
  clearStoredFlashcards,
  deleteStoredFlashcard,
  getAllStoredFlashcards,
  getStoredFlashcard,
  storeFlashcardInfo,
} from '../services/flashcardStorage';

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
  handleTag: (_tag: TagEvent) => {},
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
  const isNfcEnabledRef = useRef(isNfcEnabled);
  const handleTagRef = useRef<(scannedTag: TagEvent) => void>(() => {});

  useEffect(() => {
    checkNfc();
  }, []);

  useEffect(() => {
    isNfcEnabledRef.current = isNfcEnabled;
  }, [isNfcEnabled]);

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
    if (!isNfcEnabledRef.current) {
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
          } else if (currentScreen === 'Rewards' && isRewardsEnabled()) {
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

  useEffect(() => {
    handleTagRef.current = handleTag;
  });

  useEffect(() => {
    if (Platform.OS === 'ios') {
      return;
    }

    const onDiscoverTag = (scannedTag: TagEvent) => {
      handleTagRef.current(scannedTag);
    };

    const onSessionClosed = () => {
      NfcManager.cancelTechnologyRequest();
      NfcManager.unregisterTagEvent();
    };

    NfcManager.setEventListener(NfcEvents.DiscoverTag, onDiscoverTag);
    NfcManager.setEventListener(NfcEvents.SessionClosed, onSessionClosed);
    NfcManager.registerTagEvent();

    return () => {
      NfcManager.setEventListener(NfcEvents.DiscoverTag, null);
      NfcManager.setEventListener(NfcEvents.SessionClosed, null);
      NfcManager.cancelTechnologyRequest();
      NfcManager.unregisterTagEvent();
    };
  }, []);

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
      await storeFlashcardInfo(tagId, cardLnurl, cardBalanceInSats);
    } catch (err) {}
  };

  const getStoredCardInfo = async (
    tagId: string,
  ): Promise<StoredCardInfo | null> => {
    try {
      return await getStoredFlashcard(tagId);
    } catch (err) {
      return null;
    }
  };

  const getAllStoredCards = async (): Promise<StoredCardInfo[]> => {
    try {
      return await getAllStoredFlashcards();
    } catch (err) {
      return [];
    }
  };

  const deleteStoredCard = async (tagId: string): Promise<boolean> => {
    try {
      return await deleteStoredFlashcard(tagId);
    } catch (err) {
      return false;
    }
  };

  const clearAllStoredCards = async (): Promise<boolean> => {
    try {
      return await clearStoredFlashcards();
    } catch (err) {
      return false;
    }
  };

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
