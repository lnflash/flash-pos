import React, {useCallback, useEffect, useState} from 'react';
import {Share} from 'react-native';
import styled from 'styled-components/native';
import Clipboard from '@react-native-clipboard/clipboard';
import {StackScreenProps} from '@react-navigation/stack';
import {useFocusEffect} from '@react-navigation/native';
import {URL} from 'react-native-url-polyfill';
import axios from 'axios';

// components
import {
  Amount,
  ExpireTime,
  InvoiceQRCode,
  PrimaryButton,
  TextButton,
} from '../components';
import {ActivityIndicator} from '../contexts/ActivityIndicator';

// hooks
import {useFlashcard} from '../hooks';
import {useAppDispatch, useAppSelector} from '../store/hooks';

// utils
import {toastShow} from '../utils/toast';
import {useSubscription} from '@apollo/client';
import {calculateReward} from '../utils/rewardCalculations';

// gql
import {LnInvoicePaymentStatus} from '../graphql/subscriptions';

// store
import {resetInvoice} from '../store/slices/invoiceSlice';
import {addTransaction} from '../store/slices/transactionHistorySlice';
import {
  selectIsRewardEnabled,
  selectRewardConfig,
  selectMerchantRewardId,
} from '../store/slices/rewardSlice';

// env
import {BTC_PAY_SERVER} from '@env';

type Props = StackScreenProps<RootStackType, 'Invoice'>;

const Invoice: React.FC<Props> = ({navigation}) => {
  const dispatch = useAppDispatch();
  const {paymentRequest, paymentHash, paymentSecret} = useAppSelector(
    state => state.invoice,
  );
  const {satAmount, displayAmount, currency, isPrimaryAmountSats, memo} =
    useAppSelector(state => state.amount);
  const {username} = useAppSelector(state => state.user);
  const isRewardEnabled = useAppSelector(selectIsRewardEnabled);
  const rewardConfig = useAppSelector(selectRewardConfig);
  const merchantRewardId = useAppSelector(selectMerchantRewardId);

  const [paymentLoading, setPaymentLoading] = useState(false);
  const [errMessage, setErrMessage] = useState('');

  const {k1, callback, lnurl, tag, loading, resetFlashcard, getAllStoredCards} =
    useFlashcard();

  const {data, error} = useSubscription(LnInvoicePaymentStatus, {
    variables: {
      input: {paymentRequest},
    },
    skip: !paymentRequest,
  });

  const getCardLnurlFromStorage = useCallback(async (): Promise<
    string | null
  > => {
    try {
      if (!tag?.id) {
        return null;
      }
      const allCards = await getAllStoredCards();
      const cardInfo = allCards.find(card => card.tagId === tag.id);

      if (cardInfo && cardInfo.lnurl) {
        return cardInfo.lnurl;
      } else {
        return null;
      }
    } catch (err) {
      return null;
    }
  }, [tag?.id, getAllStoredCards]);

  const sendRewardsToCard = useCallback(
    async (cardLnurl: string, rewardAmount: number) => {
      try {
        // Validate merchant reward ID
        if (!merchantRewardId || merchantRewardId.trim() === '') {
          throw new Error(
            'Merchant Reward ID not configured. Please set it in Rewards Settings.',
          );
        }

        // Use the BTCPay Server API to send rewards to the card
        const response = await axios.post(
          `${BTC_PAY_SERVER}/api/v1/pull-payments/${merchantRewardId}/payouts`,
          {
            amount: rewardAmount,
            destination: cardLnurl,
            payoutMethodId: 'BTC-LN',
          },
        );

        toastShow({
          message: `${rewardAmount} sats sent to your NFC card!`,
          type: 'success',
        });

        return true;
      } catch (err: any) {
        toastShow({
          message:
            'Rewards calculated but could not be sent to card. Please contact support.',
          type: 'error',
        });
        return false;
      }
    },
    [merchantRewardId],
  );

  const handleSuccessfulPayment = useCallback(async () => {
    // Calculate reward information if rewards are enabled
    let rewardInfo;
    let rewardSentToCard = false;

    if (isRewardEnabled && satAmount) {
      const calculatedReward = calculateReward(Number(satAmount), rewardConfig);

      // Try to get LNURL from context state, fallback to storage lookup
      let cardLnurl = lnurl;
      if (!cardLnurl) {
        const storageLnurl = await getCardLnurlFromStorage();
        if (storageLnurl) {
          cardLnurl = storageLnurl;
        }
      }

      // If we have an NFC card LNURL, send rewards to the card
      if (cardLnurl && calculatedReward.rewardAmount > 0) {
        rewardSentToCard = await sendRewardsToCard(
          cardLnurl,
          calculatedReward.rewardAmount,
        );
      } else {
      }

      rewardInfo = {
        rewardAmount: calculatedReward.rewardAmount,
        rewardRate: rewardConfig.rewardRate,
        wasMinimumApplied: calculatedReward.appliedMinimum || false,
        wasMaximumApplied: calculatedReward.appliedMaximum || false,
        isStandalone: false, // This is a purchase-based reward
        timestamp: new Date().toISOString(),
        sentToCard: rewardSentToCard,
        cardLnurl: cardLnurl || undefined,
      };
    }

    // Create and store transaction data
    const transactionData: TransactionData = {
      id: paymentHash || `tx_${Date.now()}`,
      timestamp: new Date().toISOString(),
      transactionType: 'lightning', // Lightning payment transaction
      paymentMethod: tag ? 'lightning' : 'lightning', // Keep consistent for now
      amount: {
        satAmount: Number(satAmount) || 0,
        displayAmount: displayAmount || '0',
        currency,
        isPrimaryAmountSats: isPrimaryAmountSats || false,
      },
      merchant: {
        username: username || 'Unknown',
      },
      invoice: {
        paymentHash: paymentHash || '',
        paymentRequest: paymentRequest || '',
        paymentSecret: paymentSecret || '',
      },
      memo,
      status: 'completed',
      reward: rewardInfo,
    };

    dispatch(addTransaction(transactionData));
    dispatch(resetInvoice());

    // Clean up NFC state after payment
    if (tag) {
      resetFlashcard();
    }

    // Navigate to Success screen
    if (satAmount) {
      navigation.replace('Success');
    }
  }, [
    dispatch,
    paymentHash,
    satAmount,
    displayAmount,
    currency,
    isPrimaryAmountSats,
    username,
    paymentRequest,
    paymentSecret,
    memo,
    isRewardEnabled,
    rewardConfig,
    navigation,
    lnurl,
    sendRewardsToCard,
    tag,
    resetFlashcard,
    k1,
    callback,
    getCardLnurlFromStorage,
  ]);

  useEffect(() => {
    if (data) {
      const {status, errors} = data.lnInvoicePaymentStatus;
      if (status === 'PAID') {
        setPaymentLoading(false);
        handleSuccessfulPayment();
      } else if (errors?.length > 0) {
        setPaymentLoading(false);
        setErrMessage(
          'Please try again. Either the invoice has expired or it has not been paid.',
        );
      }
    } else if (error) {
      setPaymentLoading(false);
      setErrMessage(error.message || 'An unexpected error occurred.');
    }
  }, [data, error, handleSuccessfulPayment]);

  const payUsingFlashcard = useCallback(async () => {
    if (!k1 || !callback) {
      return;
    }

    try {
      setPaymentLoading(true);
      const urlObject = new URL(callback);
      urlObject.searchParams.set('k1', k1);
      urlObject.searchParams.set('pr', paymentRequest);
      const url = urlObject.toString();

      const result = await fetch(url);
      const lnurlResponse = await result.json();
      // LNURL response processed

      resetFlashcard();
      if (lnurlResponse.status === 'ERROR') {
        setPaymentLoading(false);
        toastShow({message: lnurlResponse.reason, type: 'error'});
      }
    } catch (err) {
      setPaymentLoading(false);
      toastShow({message: 'Payment failed. Please try again.', type: 'error'});
    }
  }, [k1, callback, paymentRequest, resetFlashcard]);

  useFocusEffect(
    useCallback(() => {
      if (loading || !k1 || !callback || !paymentRequest) {
        return;
      }
      payUsingFlashcard();
    }, [loading, k1, callback, paymentRequest, payUsingFlashcard]),
  );

  const onCopy = () => {
    if (!errMessage) {
      Clipboard.setString(paymentRequest);
      toastShow({message: 'Copied!'});
    }
  };

  const onShare = async () => {
    if (!errMessage) {
      try {
        await Share.share({message: paymentRequest});
      } catch (err) {}
    }
  };

  if (paymentLoading) {
    return <ActivityIndicator />;
  }

  return (
    <Wrapper>
      <InnerWrapper>
        <Amount
          hideTransactionHistory={!!paymentRequest}
          hideCurrency
          hideToggle
          hideSecondary
        />
        <ExpireTime setErrMessage={setErrMessage} />
        <InvoiceQRCode errMessage={errMessage} />
        {!errMessage && (
          <RowWrapper>
            <TextButton icon="clone" title="Copy" onPress={onCopy} />
            <TextButton
              icon="arrow-up-from-bracket"
              title="Share"
              onPress={onShare}
            />
          </RowWrapper>
        )}
      </InnerWrapper>
      <PrimaryButton btnText="Back" onPress={() => navigation.goBack()} />
    </Wrapper>
  );
};

export default Invoice;

const Wrapper = styled.View`
  flex: 1;
  background-color: #fff;
  padding-bottom: 20px;
  padding-horizontal: 20px;
`;

const InnerWrapper = styled.View`
  flex: 1;
`;

const RowWrapper = styled.View`
  flex-direction: row;
  align-items: center;
  justify-content: space-between;
  margin-top: 10px;
  margin-horizontal: 10px;
`;
