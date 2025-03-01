import React from 'react';
import styled from 'styled-components/native';
import {StackScreenProps} from '@react-navigation/stack';

// components
import {RecentActivity} from '../components/flashcardBalance';

// assets
import Flashcard from '../assets/images/flashcard.svg';
import Refresh from '../assets/icons/refresh.svg';

const data = [
  {date: '2025-02-24T15:37:47.5500130+00:00', sats: 21},
  {date: '2025-02-24T15:35:37.8752400+00:00', sats: -11},
  {date: '2025-02-24T11:14:10.9649570+00:00', sats: -15},
  {date: '2025-02-24T08:24:34.1396280+00:00', sats: 32},
  {date: '2025-02-24T08:22:38.8883590+00:00', sats: 32},
  {date: '2025-02-24T08:22:12.7270790+00:00', sats: 11},
  {date: '2025-02-24T08:18:19.6360690+00:00', sats: 11},
  {date: '2025-02-24T08:17:36.7762580+00:00', sats: 11},
  {date: '2025-02-24T08:16:59.5641850+00:00', sats: 11},
  {date: '2025-02-24T08:16:59.5517030+00:00', sats: 11},
  {date: '2025-02-24T08:16:48.1287830+00:00', sats: 11},
  {date: '2025-02-24T08:11:24.5264210+00:00', sats: 11},
  {date: '2025-02-24T08:10:34.4153190+00:00', sats: 11},
  {date: '2025-02-24T08:08:38.9797430+00:00', sats: 11},
  {date: '2025-02-24T08:07:19.7591680+00:00', sats: 11},
  {date: '2025-02-24T08:06:06.1720300+00:00', sats: 11},
  {date: '2025-02-24T07:34:31.5988080+00:00', sats: 11},
  {date: '2025-02-24T07:34:06.4111130+00:00', sats: 11},
  {date: '2025-02-24T07:33:43.0212180+00:00', sats: 11},
  {date: '2025-02-24T07:29:11.4696960+00:00', sats: 11},
  {date: '2025-02-24T06:53:17.2244280+00:00', sats: 11},
  {date: '2025-02-24T06:47:36.8537120+00:00', sats: 11},
  {date: '2025-02-24T06:40:51.3543730+00:00', sats: 11},
  {date: '2025-02-17T09:51:46.4476920+00:00', sats: 21},
  {date: '2025-01-28T14:34:54.1513590+00:00', sats: -10},
  {date: '2025-01-28T14:24:04.4378290+00:00', sats: -10},
  {date: '2025-01-28T14:17:35.6616000+00:00', sats: -30},
  {date: '2024-08-18T08:56:19.0484010+00:00', sats: 16},
  {date: '2024-08-18T08:55:13.8818960+00:00', sats: -17},
  {date: '2024-08-09T04:23:38.3003700+00:00', sats: 25},
  {date: '2024-08-07T12:37:04.3582770+00:00', sats: 1},
];

type Props = StackScreenProps<RootStackType, 'FlashcardBalance'>;

const FlashcardBalance: React.FC<Props> = ({navigation, route}) => {
  return (
    <Wrapper>
      <Image source={Flashcard} />
      <BalanceWrapper>
        <Balance>$239.18</Balance>
        <ReloadBtn>
          <ReloadIcon source={Refresh} />
        </ReloadBtn>
      </BalanceWrapper>
      <RecentActivity transactions={data} />
    </Wrapper>
  );
};

export default FlashcardBalance;

const Wrapper = styled.View`
  flex: 1;
  background-color: #fff;
  padding-top: 220px;
`;

const Image = styled.Image`
  position: absolute;
  top: 10px;
`;

const BalanceWrapper = styled.View`
  flex-direction: row;
  align-items: center;
  justify-content: center;
  margin-top: 20px;
`;

const Balance = styled.Text`
  font-size: 40px;
  font-family: 'Outfit-Regular';
  color: #212121;
`;

const ReloadBtn = styled.TouchableOpacity`
  padding: 14px;
`;

const ReloadIcon = styled.Image``;
