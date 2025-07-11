import React from 'react';
import {Icon} from '@rneui/themed';
import {StackNavigationProp} from '@react-navigation/stack';
import {Column, Container, Key, Label, Value, Wrapper} from './styled';

// hooks
import {useAppSelector} from '../../store/hooks';
import {useNavigation} from '@react-navigation/native';

type NavigationProps = StackNavigationProp<RootStackType, 'Home'>;

const Transactions = () => {
  const navigation = useNavigation<NavigationProps>();

  const {transactions} = useAppSelector(state => state.transactionHistory);

  const onViewTransactionHistory = () => {
    navigation.navigate('TransactionHistory');
  };

  return (
    <Wrapper>
      <Label>Transactions</Label>
      <Container activeOpacity={0.5} onPress={onViewTransactionHistory}>
        <Icon name={'receipt-outline'} type="ionicon" />
        <Column>
          <Key>Transaction History</Key>
          <Value>{transactions.length} transactions</Value>
        </Column>
        <Icon name={'chevron-forward-outline'} type="ionicon" />
      </Container>
    </Wrapper>
  );
};

export default Transactions;
