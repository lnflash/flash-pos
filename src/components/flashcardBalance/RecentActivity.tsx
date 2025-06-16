import React from 'react';
import {FlatList} from 'react-native';
import styled from 'styled-components/native';
import {Icon} from '@rneui/themed';
import moment from 'moment';

// hooks
import {useRealtimePrice} from '../../hooks';

type RenderItem = {
  item: TransactionItem;
  index: number;
};

type Props = {
  transactions?: TransactionList;
};

const RecentActivity: React.FC<Props> = ({transactions}) => {
  const {satsToCurrency} = useRealtimePrice();

  const renderItem = ({item, index}: RenderItem) => {
    const sats = parseInt(item.sats.replaceAll(',', ''), 10);
    return (
      <RowWrapper>
        <Icon
          name={sats < 0 ? 'arrow-up' : 'arrow-down'}
          size={20}
          type="ionicon"
          color={sats < 0 ? '#B31B1B' : '#007856'}
        />
        <Date>{moment(item.date).format('MMM Do, h:mm a')}</Date>
        <ColumnWrapper>
          <DisplayAmount>
            {satsToCurrency(sats).formattedCurrency}
          </DisplayAmount>
          <Sats>{`${item.sats} POINTS`}</Sats>
        </ColumnWrapper>
      </RowWrapper>
    );
  };

  return (
    <Wrapper>
      <Title>Recent activity</Title>
      <FlatList
        data={transactions}
        renderItem={renderItem}
        style={{paddingHorizontal: 20}}
      />
    </Wrapper>
  );
};

export default RecentActivity;

const Wrapper = styled.View`
  flex: 1;
`;

const Title = styled.Text`
  font-size: 16px;
  font-family: 'Outfit-Medium';
  color: #212121;
  padding-horizontal: 20px;
  padding-vertical: 10px;
`;

const RowWrapper = styled.View`
  flex-direction: row;
  align-items: center;
  border-bottom-width: 1px;
  border-bottom-color: #e1e1e1;
  padding-vertical: 5px;
`;

const Date = styled.Text`
  font-size: 14px;
  font-family: 'Outfit-Regular';
  color: #212121;
  margin-left: 10px;
`;

const ColumnWrapper = styled.View`
  flex: 1;
  align-items: flex-end;
`;

const DisplayAmount = styled.Text`
  font-size: 14px;
  font-family: 'Outfit-Regular';
  color: #212121;
`;

const Sats = styled.Text`
  font-size: 12px;
  font-family: 'Outfit-Regular';
  color: #829993;
`;
