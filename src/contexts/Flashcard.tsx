import React, {createContext, useEffect, useState} from 'react';
import NfcManager, {Ndef, NfcEvents, TagEvent} from 'react-native-nfc-manager';
import {ActivityIndicator} from 'react-native';
import styled from 'styled-components/native';
import {getParams} from 'js-lnurl';
import axios from 'axios';

// utils
import {toastShow} from '../utils/toast';

// env
import {BTC_PAY_SERVER} from '@env';

// route
import {navigationRef} from '../routes';

interface FlashcardInterface {
  tag?: TagEvent;
  k1?: string;
  callback?: string;
  lnurl?: string;
  balanceInSats?: number;
  transactions?: TransactionList;
  loading?: boolean;
  error?: string;
  resetFlashcard: () => void;
}

export const FlashcardContext = createContext<FlashcardInterface>({
  tag: undefined,
  k1: undefined,
  callback: undefined,
  lnurl: undefined,
  balanceInSats: undefined,
  transactions: undefined,
  loading: undefined,
  error: undefined,
  resetFlashcard: () => {},
});

type Props = {
  children: string | JSX.Element | JSX.Element[];
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
    } else {
      // NFC IS ENABLES AND SUPPORTED
    }
  };

  const handleTag = async (tag: TagEvent) => {
    const currentScreen = navigationRef.getCurrentRoute()?.name;
    if (tag && tag.id) {
      const ndefRecord = tag?.ndefMessage?.[0];
      if (!ndefRecord) {
        toastShow({message: 'NDEF message not found.', type: 'error'});
      } else {
        setLoading(true);
        const payload = Ndef.text.decodePayload(
          new Uint8Array(ndefRecord.payload),
        );
        if (payload.startsWith('lnurlw')) {
          setTag(tag);
          console.log('CURRENT SCREEN>>>>>>>>>', currentScreen);
          if (currentScreen === 'Invoice') {
            await getPayDetails(payload);
          } else {
            await getHtml(payload, currentScreen);
          }
        }
        setLoading(false);
      }
    } else {
      toastShow({message: 'No tag found', type: 'error'});
    }
  };

  const getPayDetails = async (payload: string) => {
    try {
      const lnurlParams = await getParams(payload);
      if ('tag' in lnurlParams && lnurlParams.tag === 'withdrawRequest') {
        const {k1, callback} = lnurlParams;

        console.log('K1>>>>>>>>>>>>>>', k1);
        console.log('CALLBACK>>>>>>>>>>>>>', callback);
        setK1(k1);
        setCallback(callback);
      } else {
        toastShow({
          message: `not a properly configured lnurl withdraw tag\n\n${payload}\n\n${
            'reason' in lnurlParams && lnurlParams.reason
          }`,
          type: 'error',
        });
      }
    } catch (err) {
      console.log('NFC ERROR:', err);
      toastShow({
        message:
          'Unsupported NFC card. Please ensure you are using a flashcard.',
        type: 'error',
      });
    }
  };

  const getHtml = async (payload: string, currentScreen?: string) => {
    try {
      const payloadPart = payload.split('?')[1];
      const url = `${BTC_PAY_SERVER}/boltcards/balance?${payloadPart}`;
      const response = await axios.get(url);
      const html = response.data;

      getLnurl(html);
      getBalance(html);
      getTransactions(html);

      if (currentScreen !== 'Rewards' && navigationRef.isReady()) {
        navigationRef.navigate('FlashcardBalance');
      }
    } catch (err) {
      console.log('NFC ERROR:', err);
      toastShow({
        message:
          'Unsupported NFC card. Please ensure you are using a flashcard.',
        type: 'error',
      });
    }
  };

  const getLnurl = (html: string) => {
    const lnurlMatch = html.match(/href="lightning:(lnurl\w+)"/);
    if (lnurlMatch) {
      console.log('LNURL MATCH>>>>>>>>>>', lnurlMatch[1]);
      setLnurl(lnurlMatch[1]);
    }
  };

  const getBalance = (html: string) => {
    const balanceMatch = html.match(/(\d{1,3}(?:,\d{3})*)\s*SATS<\/dt>/);
    if (balanceMatch) {
      const parsedBalance = balanceMatch[1].replace(/,/g, ''); // Remove commas
      const satoshiAmount = parseInt(parsedBalance, 10);

      console.log('SATOSHI AMOUNT>>>>>>>>>>>>>>>', satoshiAmount);
      setBalanceInSats(satoshiAmount);
    }
  };

  const getTransactions = (html: string) => {
    // Extract dates and SATS amounts
    const transactionMatches = [
      ...html.matchAll(
        /<time datetime="(.*?)".*?>.*?<\/time>\s*<\/td>\s*<td.*?>\s*<span.*?>(-?\d+) SATS<\/span>/g,
      ),
    ];
    const data = transactionMatches.map(match => ({
      date: match[1], // Extracted datetime value
      sats: parseInt(match[2], 10), // Convert SATS value to integer
    }));
    setTransactions(data);
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

  NfcManager.setEventListener(NfcEvents.DiscoverTag, (tag: TagEvent) => {
    handleTag(tag);
  });

  NfcManager.setEventListener(NfcEvents.SessionClosed, () => {
    NfcManager.cancelTechnologyRequest();
    NfcManager.unregisterTagEvent();
  });

  NfcManager.registerTagEvent();

  return (
    <FlashcardContext.Provider
      value={{
        tag,
        k1,
        callback,
        lnurl,
        balanceInSats,
        transactions,
        loading,
        error,
        resetFlashcard,
      }}>
      {children}
      {loading && (
        <Backdrop>
          <ActivityIndicator color={'#002118'} size={'large'} />
        </Backdrop>
      )}
    </FlashcardContext.Provider>
  );
};

const Backdrop = styled.View`
  position: absolute;
  top: 0;
  left: 0;
  right: 0;
  bottom: 0;
  z-index: 1;
  align-items: center;
  justify-content: center;
  background-color: rgba(0, 0, 0, 0);
`;
