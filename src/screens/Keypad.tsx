import React from 'react';
import styled from 'styled-components/native';
import {StackNavigationProp} from '@react-navigation/stack';

// components
import {
  Amount,
  Note,
  NumPad,
  PrimaryButton,
  SecondaryButton,
} from '../components';

// hooks
import {useAppDispatch, useAppSelector} from '../store/hooks';
import {useActivityIndicator, useSatPrice} from '../hooks';
import {useNavigation} from '@react-navigation/native';
import {useMutation} from '@apollo/client';

// gql
import {LnUsdInvoiceCreateOnBehalfOfRecipient} from '../graphql/mutations';

// store
import {updateAmount} from '../store/slices/amountSlice';
import {setInvoice} from '../store/slices/invoiceSlice';

// utils
import {toastShow} from '../utils/toast';

type Props = StackNavigationProp<RootStackType, 'Home'>;

const Keypad = () => {
  const navigation = useNavigation<Props>();
  const [createInvoice] = useMutation(LnUsdInvoiceCreateOnBehalfOfRecipient);

  const {toggleLoading} = useActivityIndicator();
  const {satsToUsd} = useSatPrice();

  const dispatch = useAppDispatch();
  const {walletId} = useAppSelector(state => state.user);
  const {satAmount, memo} = useAppSelector(state => state.amount);

  const onCreateInvoice = () => {
    try {
      toggleLoading(true);
      const usdAmount = satsToUsd(Number(satAmount));
      const cents = parseFloat(usdAmount.toFixed(2)) * 100;
      const amount = cents.toFixed();

      createInvoice({
        variables: {
          input: {
            recipientWalletId: walletId,
            amount: Number(amount),
            memo,
          },
        },
      })
        .then(({data}) => {
          console.log(
            'INVOICE DATA:',
            data.lnUsdInvoiceCreateOnBehalfOfRecipient,
          );
          if (data.lnUsdInvoiceCreateOnBehalfOfRecipient.invoice) {
            dispatch(
              setInvoice(data.lnUsdInvoiceCreateOnBehalfOfRecipient.invoice),
            );
            navigation.navigate('Invoice');
          } else {
            toastShow({
              message:
                'Unexpected error occurred, please try again or contact support if it persists',
              type: 'error',
            });
          }
        })
        .catch(err => {
          console.error(err);
        })
        .finally(() => {
          toggleLoading(false);
        });
    } catch (err) {
      console.log('ERROR: ', err);
    }
  };

  return (
    <Wrapper>
      <BodyWrapper>
        <Amount style={{marginHorizontal: 20}} />
        <Note />
        <NumPad />
      </BodyWrapper>
      <BtnsWrapper>
        <PrimaryButton btnText="Next" onPress={onCreateInvoice} />
      </BtnsWrapper>
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
