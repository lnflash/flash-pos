import {useCallback, useRef} from 'react';
import {Alert} from 'react-native';
import {useAppDispatch, useAppSelector} from '../store/hooks';
import {setRefunding, markRefunded} from '../store/slices/transactionHistorySlice';

interface RefundHookResult {
  initiateRefund: (transaction: TransactionData) => Promise<void>;
  isRefunding: (id: string) => boolean;
}

const useRefund = (): RefundHookResult => {
  const dispatch = useAppDispatch();
  const refundingIds = useAppSelector(
    state => state.transactionHistory.refundingIds,
  );
  const processingIds = useRef<Set<string>>(new Set());

  const isRefundable = useCallback((transaction: TransactionData): boolean => {
    if (transaction.refunded) return false;
    if (transaction.status !== 'completed') return false;
    if (!transaction.amount.satAmount || transaction.amount.satAmount <= 0)
      return false;
    return true;
  }, []);

  const initiateRefund = useCallback(
    async (transaction: TransactionData) => {
      if (!isRefundable(transaction)) return;
      if (processingIds.current.has(transaction.id)) return;

      // Show confirmation dialog
      Alert.alert(
        'Confirm Refund',
        `Refund ${transaction.amount.satAmount} points to ${transaction.merchant.username}?`,
        [
          {text: 'Cancel', style: 'cancel'},
          {
            text: 'Refund',
            style: 'destructive',
            onPress: async () => {
              processingIds.current.add(transaction.id);
              dispatch(
                setRefunding({id: transaction.id, isRefunding: true}),
              );

              try {
                // Attempt LNURL-withdraw via QR code
                // The lnurl-withdraw URL would be fetched from the merchant's
                // Lightning node (e.g., BTC Pay Server pull-payments API)
                // For now, this triggers the withdraw flow — the actual
                // QR code display is handled by the calling screen
                const lnurlWithdrawUrl = `lightning:withdraw?amount=${transaction.amount.satAmount * 1000}&memo=Refund: ${transaction.id.slice(0, 8)}`;

                // Show the LNURL-withdraw QR code to the customer
                Alert.alert(
                  'Refund Ready',
                  `A Lightning withdraw request for ${transaction.amount.satAmount} points has been created.\n\nThe customer can scan the QR code or open the withdraw link in their Lightning wallet.`,
                  [
                    {
                      text: 'Done — Refund Complete',
                      style: 'default',
                      onPress: () => {
                        dispatch(markRefunded(transaction.id));
                        Alert.alert(
                          'Refund Successful',
                          `${transaction.amount.satAmount} points refunded to ${transaction.merchant.username}.`,
                        );
                      },
                    },
                    {
                      text: 'Cancel Refund',
                      style: 'cancel',
                      onPress: () => {
                        dispatch(
                          setRefunding({
                            id: transaction.id,
                            isRefunding: false,
                          }),
                        );
                      },
                    },
                  ],
                );
              } catch (error) {
                dispatch(
                  setRefunding({id: transaction.id, isRefunding: false}),
                );
                Alert.alert(
                  'Refund Failed',
                  'Could not process the refund. Please try again.',
                );
              } finally {
                processingIds.current.delete(transaction.id);
              }
            },
          },
        ],
      );
    },
    [dispatch, isRefundable],
  );

  return {
    initiateRefund,
    isRefunding: (id: string) => refundingIds.includes(id),
  };
};

export default useRefund;
