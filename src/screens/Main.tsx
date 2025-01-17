import {useQuery} from '@apollo/client';
import React, {useEffect} from 'react';
import styled from 'styled-components/native';
import {AccountDefaultWallets} from '../graphql/queries';
import {NativeStackScreenProps} from '@react-navigation/native-stack';
import {Dimensions} from 'react-native';
import Icon from 'react-native-vector-icons/FontAwesome6';

const width = Dimensions.get('screen').width;

type Props = NativeStackScreenProps<RootStackType, 'Main'>;

const Main: React.FC<Props> = ({navigation, route}) => {
  const {loading, error, data} = useQuery(AccountDefaultWallets, {
    variables: {username: route.params.username},
  });

  useEffect(() => {
    console.log('>>>>>>>>>>', loading);
    console.log('>>>>>>>>>>', error);
    console.log('>>>>>>>>>>', data);
  }, [loading, error, data]);

  return (
    <Wrapper>
      <RowWrapper>
        <AmountWrapper>
          <Primary>$ 200</Primary>
          <Secondary>≈ 200000 sats</Secondary>
        </AmountWrapper>
      </RowWrapper>
      <NumbersWrapper>
        <RowWrapper>
          <NumBtn>
            <NumText>1</NumText>
          </NumBtn>
          <NumBtn>
            <NumText>2</NumText>
          </NumBtn>
          <NumBtn>
            <NumText>3</NumText>
          </NumBtn>
        </RowWrapper>
        <RowWrapper>
          <NumBtn>
            <NumText>4</NumText>
          </NumBtn>
          <NumBtn>
            <NumText>5</NumText>
          </NumBtn>
          <NumBtn>
            <NumText>6</NumText>
          </NumBtn>
        </RowWrapper>
        <RowWrapper>
          <NumBtn>
            <NumText>7</NumText>
          </NumBtn>
          <NumBtn>
            <NumText>8</NumText>
          </NumBtn>
          <NumBtn>
            <NumText>9</NumText>
          </NumBtn>
        </RowWrapper>
        <RowWrapper>
          <NumBtn>
            <NumText>.</NumText>
          </NumBtn>
          <NumBtn>
            <NumText>0</NumText>
          </NumBtn>
          <NumBtn>
            <NumText>
              <Icon name={'delete-left'} size={20} solid />
            </NumText>
          </NumBtn>
        </RowWrapper>
      </NumbersWrapper>
    </Wrapper>
  );
};

export default Main;

const Wrapper = styled.View`
  flex: 1;
  background-color: #fff;
  padding-horizontal: 20px;
`;

const RowWrapper = styled.View`
  flex-direction: row;
  align-items: center;
  justify-content: space-around;
`;

const AmountWrapper = styled.View`
  align-items: center;
  justify-content: center;
`;

const Primary = styled.Text`
  font-size: 26px;
  font-weight: bold;
`;

const Secondary = styled.Text`
  font-size: 18px;
`;

const NumbersWrapper = styled.View``;

const NumBtn = styled.TouchableOpacity`
  width: ${width / 5}px;
  height: ${width / 5}px;
  justify-content: center;
  align-items: center;
  border: 1px solid #adadad;
  border-radius: 10px;
  margin-bottom: 10px;
`;

const NumText = styled.Text`
  font-size: 40px;
  font-weight: bold;
`;
