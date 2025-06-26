import React, {useCallback, useEffect} from 'react';
import styled from 'styled-components/native';
import {StackNavigationProp} from '@react-navigation/stack';
import {useFocusEffect} from '@react-navigation/native';

// components
import {
  Amount,
  FloatingButton,
  Note,
  NumPad,
  PrimaryButton,
  SecondaryButton,
} from '../components';

// hooks
import {useAppDispatch, useAppSelector} from '../store/hooks';
import {useActivityIndicator, useSatPrice, useRealtimePrice} from '../hooks';
import {useNavigation} from '@react-navigation/native';
import {useMutation} from '@apollo/client';

// gql
import {LnUsdInvoiceCreateOnBehalfOfRecipient} from '../graphql/mutations';

// store
import {setInvoice} from '../store/slices/invoiceSlice';
import {setIsPrimaryAmountSats, resetAmount} from '../store/slices/amountSlice';
import {selectRewardConfig} from '../store/slices/rewardSlice';

// utils
import {toastShow} from '../utils/toast';

type Props = StackNavigationProp<RootStackType, 'Home'>;

const Keypad = () => {
  const navigation = useNavigation<Props>();
  const [createInvoice] = useMutation(LnUsdInvoiceCreateOnBehalfOfRecipient);

  const {toggleLoading} = useActivityIndicator();
  const {satsToUsd} = useSatPrice();
  const {currencyToSats} = useRealtimePrice();

  const dispatch = useAppDispatch();
  const {walletId} = useAppSelector(state => state.user);
  const {satAmount, memo, displayAmount, currency, isPrimaryAmountSats} =
    useAppSelector(state => state.amount);
  const rewardConfig = useAppSelector(selectRewardConfig);

  // Ensure currency is always shown as primary amount since toggle is hidden
  useEffect(() => {
    if (isPrimaryAmountSats) {
      dispatch(setIsPrimaryAmountSats(false));
    }
  }, [isPrimaryAmountSats, dispatch]);

  // Reset amount when returning to the keypad screen
  useFocusEffect(
    useCallback(() => {
      dispatch(resetAmount());
    }, [dispatch]),
  );

  const isValidAmount =
    displayAmount && displayAmount !== '0' && Number(displayAmount) > 0;

  // External Payment Rewards - "Give Points" functionality
  const onGivePoints = useCallback(() => {
    if (!satAmount || !displayAmount || !isValidAmount) {
      toastShow({
        message: 'Please enter a valid amount',
        type: 'error',
      });
      return;
    }

    navigation.navigate('Rewards', {
      purchaseAmount: Number(satAmount),
      purchaseCurrency: currency.id,
      purchaseDisplayAmount: `${currency.symbol}${displayAmount}`,
      isExternalPayment: true,
      paymentMethod: 'external',
    });
  }, [satAmount, displayAmount, currency, navigation, isValidAmount]);

  const onCreateInvoice = async () => {
    try {
      // Validate amount before processing
      const numericAmount = Number(displayAmount);

      if (!numericAmount || numericAmount <= 0) {
        toastShow({
          message: 'Please enter a valid amount',
          type: 'error',
        });
        return;
      }

      // Convert US$10,000 to local currency for comparison
      // First convert 1 local currency unit to sats, then estimate USD equivalent
      const {convertedCurrencyAmount: satsPerLocalUnit} = currencyToSats(1);
      const usdPerSat = satsToUsd(1);
      const usdPerLocalUnit = satsPerLocalUnit * usdPerSat;
      const maxLocalAmount = Math.round(10000 / usdPerLocalUnit);

      if (numericAmount > maxLocalAmount) {
        toastShow({
          message: `Amount too large. Maximum allowed is ${
            currency.symbol
          }${maxLocalAmount.toLocaleString()} (US$10,000 equivalent)`,
          type: 'error',
        });
        return;
      }

      toggleLoading(true);
      const usdAmount = satsToUsd(Number(satAmount));
      const cents = usdAmount * 100;
      const amount = cents;

      // Additional validation for converted amount
      const convertedAmount = Number(amount);
      if (isNaN(convertedAmount) || convertedAmount <= 0) {
        toastShow({
          message:
            'Unable to process this amount. Please try a different value.',
          type: 'error',
        });
        return;
      }

      const result = await createInvoice({
        variables: {
          input: {
            recipientWalletId: walletId,
            amount: convertedAmount,
            memo,
          },
        },
      });

      if (result.data?.lnUsdInvoiceCreateOnBehalfOfRecipient?.invoice) {
        dispatch(
          setInvoice(result.data.lnUsdInvoiceCreateOnBehalfOfRecipient.invoice),
        );
        navigation.navigate('Invoice');
      } else {
        const errorMessage =
          result.data?.lnUsdInvoiceCreateOnBehalfOfRecipient?.errors?.[0]
            ?.message;
        toastShow({
          message:
            errorMessage ||
            'Unable to create invoice. Please check your amount and try again.',
          type: 'error',
        });
      }
    } catch (err: any) {
      console.error('Invoice creation error:', err);
      let errorMessage = 'Unable to create invoice. Please try again.';

      if (err.message?.includes('amount')) {
        errorMessage =
          'The amount entered is invalid or too large. Please try a smaller amount.';
      } else if (err.message?.includes('network')) {
        errorMessage =
          'Network error. Please check your connection and try again.';
      }

      toastShow({
        message: errorMessage,
        type: 'error',
      });
    } finally {
      toggleLoading(false);
    }
  };

  return (
    <Wrapper>
      <BodyWrapper>
        <Amount
          style={{marginHorizontal: 20}}
          hideToggle={true}
          hideCurrency={false}
          hideSecondary={true}
        />
        <Note />
        <NumPad />
      </BodyWrapper>
      <BtnsWrapper>
        <ButtonRow>
          {rewardConfig.isEnabled && (
            <SecondaryButton
              btnText="Give Points"
              onPress={isValidAmount ? onGivePoints : () => {}}
              btnStyle={{
                flex: 1,
                marginRight: rewardConfig.isEnabled ? 8 : 0,
                marginBottom: 0,
                paddingVertical: 15,
              }}
            />
          )}
          <PrimaryButton
            btnText="Next"
            onPress={isValidAmount ? onCreateInvoice : () => {}}
            btnStyle={{
              flex: 1,
              marginLeft: rewardConfig.isEnabled ? 8 : 0,
              paddingVertical: 15,
            }}
          />
        </ButtonRow>
      </BtnsWrapper>
      <FloatingButton
        icon="message"
        onPress={() => navigation.navigate('SupportChat')}
      />
    </Wrapper>
  );
};

export default Keypad;

const Wrapper = styled.View`
  flex: 1;
  background-color: #fff;
  padding-bottom: 80px;
`;

const BodyWrapper = styled.View`
  flex: 1;
`;

const BtnsWrapper = styled.View`
  padding-horizontal: 20px;
`;

const ButtonRow = styled.View`
  flex-direction: row;
  align-items: center;
  justify-content: space-between;
  gap: 0px;
`;
