import React from 'react';
import styled from 'styled-components/native';
import {NativeStackScreenProps} from '@react-navigation/native-stack';

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
import {useMutation} from '@apollo/client';

// gql
import {LnUsdInvoiceCreateOnBehalfOfRecipient} from '../graphql/mutations';

// store
import {updateAmount} from '../store/slices/amountSlice';
import {setInvoice} from '../store/slices/invoiceSlice';

type Props = NativeStackScreenProps<RootStackType, 'Main'>;

const Main: React.FC<Props> = ({navigation, route}) => {
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
            data.lnUsdInvoiceCreateOnBehalfOfRecipient.invoice,
          );
          if (data.lnUsdInvoiceCreateOnBehalfOfRecipient.invoice) {
            dispatch(
              setInvoice(data.lnUsdInvoiceCreateOnBehalfOfRecipient.invoice),
            );
            navigation.navigate('Invoice');
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
        <SecondaryButton
          icon={'arrow-rotate-left'}
          btnText="Clear"
          btnStyle={{marginTop: 10}}
          onPress={() => dispatch(updateAmount('clearInput'))}
        />
      </BtnsWrapper>
    </Wrapper>
  );
};

export default Main;

const Wrapper = styled.View`
  flex: 1;
  background-color: #fff;
  padding-top: 10px;
  padding-bottom: 30px;
`;

const BodyWrapper = styled.View`
  flex: 1;
`;

const BtnsWrapper = styled.View`
  align-items: center;
  margin-horizontal: 20px;
`;
