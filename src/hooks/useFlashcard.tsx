import axios from 'axios';
import {useEffect, useState} from 'react';
import NfcManager, {Ndef, NfcEvents, TagEvent} from 'react-native-nfc-manager';

// hooks
import useRealtimePrice from './useRealTimePrice';
import {useActivityIndicator} from './useActivityIndicator';

// utils
import {toastShow} from '../utils/toast';

NfcManager.start();

const useFlashcard = () => {
  const {satsToCurrency} = useRealtimePrice();
  const {toggleLoading} = useActivityIndicator();

  const [loading, setLoading] = useState(false);
  const [lnurl, setLnurl] = useState<string>();
  const [satAmount, setSatAmount] = useState<number>();
  const [displayAmount, setDisplayAmount] = useState<string>();

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
    if (tag && tag.id) {
      const ndefRecord = tag?.ndefMessage?.[0];
      if (!ndefRecord) {
        toastShow({message: 'NDEF message not found.', type: 'error'});
      } else {
        toggleLoading(true);
        setLoading(true);
        const payload = Ndef.text.decodePayload(
          new Uint8Array(ndefRecord.payload),
        );

        if (payload.startsWith('lnurlw')) {
          try {
            const payloadPart = payload.split('?')[1];
            const domain = payload.split('/')[2];

            const url = `https://${domain}/boltcards/balance?${payloadPart}`;
            const response = await axios.get(url);

            const html = response.data;

            getBalance(html);
            getLnurl(html);
          } catch (err) {
            console.log('NFC ERROR:', err);
            toastShow({
              message:
                'Unsupported NFC card. Please ensure you are using a flashcard.',
              type: 'error',
            });
          }
        }
        toggleLoading(false);
        setLoading(false);
      }
    } else {
      toastShow({message: 'No tag found', type: 'error'});
    }
  };

  const getBalance = (html: string) => {
    const balanceMatch = html.match(/(\d{1,3}(?:,\d{3})*)\s*SATS<\/dt>/);
    if (balanceMatch) {
      const parsedBalance = balanceMatch[1].replace(/,/g, ''); // Remove commas
      const satoshiAmount = parseInt(parsedBalance, 10);
      const {formattedCurrency} = satsToCurrency(Number(satoshiAmount));

      console.log('SATOSHI AMOUNT>>>>>>>>>>>>>>>', satoshiAmount);
      console.log('DISPLAY AMOUNT>>>>>>>>>>>>>>>', formattedCurrency);

      setSatAmount(satoshiAmount);
      setDisplayAmount(formattedCurrency);
    }
  };

  const getLnurl = (html: string) => {
    const lnurlMatch = html.match(/href="lightning:(lnurl\w+)"/);
    if (lnurlMatch) {
      console.log('LNURL MATCH>>>>>>>>>>', lnurlMatch[1]);
      setLnurl(lnurlMatch[1]);
    }
  };

  NfcManager.setEventListener(NfcEvents.DiscoverTag, (tag: TagEvent) => {
    handleTag(tag);
  });

  NfcManager.setEventListener(NfcEvents.SessionClosed, () => {
    NfcManager.cancelTechnologyRequest();
    NfcManager.unregisterTagEvent();
  });

  NfcManager.registerTagEvent();

  return {loading, satAmount, displayAmount, lnurl};
};

export default useFlashcard;
