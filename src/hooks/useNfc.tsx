import {useEffect} from 'react';
import {getParams} from 'js-lnurl';
import {URL} from 'react-native-url-polyfill';
import {useNavigation} from '@react-navigation/native';
import {useActivityIndicator} from './useActivityIndicator';
import {StackNavigationProp} from '@react-navigation/stack';
import NfcManager, {Ndef, NfcEvents, TagEvent} from 'react-native-nfc-manager';
import {toastShow} from '../utils/toast';

NfcManager.start();

const useNfc = (paymentRequest: string) => {
  const {toggleLoading} = useActivityIndicator();
  const navigation =
    useNavigation<StackNavigationProp<RootStackType, 'Invoice'>>();

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
        const payload = Ndef.text.decodePayload(
          new Uint8Array(ndefRecord.payload),
        );

        if (payload.startsWith('lnurlw')) {
          try {
            const lnurlParams = await getParams(payload);
            if ('tag' in lnurlParams && lnurlParams.tag === 'withdrawRequest') {
              const {callback, k1} = lnurlParams;

              const urlObject = new URL(callback);
              const searchParams = urlObject.searchParams;
              searchParams.set('k1', k1);
              searchParams.set('pr', paymentRequest);

              const url = urlObject.toString();

              const result = await fetch(url);
              const lnurlResponse = await result.json();
              if (lnurlResponse.status == 'ERROR') {
                toastShow({message: lnurlResponse.reason, type: 'error'});
              } else if (lnurlResponse.status == 'OK') {
                navigation.navigate('Success', {title: lnurlResponse.reason});
              }
              console.log('RESPONSE>>>>>>>>>>>>>>>>>>', lnurlResponse);
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
          }
        }
        toggleLoading(false);
      }
    } else {
      toastShow({message: 'No tag found', type: 'error'});
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
};

export default useNfc;
