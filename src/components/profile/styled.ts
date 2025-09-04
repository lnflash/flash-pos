import styled from 'styled-components/native';

export const Wrapper = styled.View`
  margin-bottom: 20px;
`;

export const Label = styled.Text`
  font-size: 16px;
  font-family: 'Outfit-Bold';
  color: #000000;
`;

export const Container = styled.TouchableOpacity`
  flex-direction: row;
  background-color: #f2f2f4;
  border-radius: 12px;
  overflow: hidden;
  align-items: center;
  justify-content: space-between;
  padding: 16px;
  min-height: 60px;
  margin-top: 8px;
`;

export const Column = styled.View`
  flex: 1;
  margin-left: 8px;
  margin-right: 12px;
`;

export const Key = styled.Text`
  font-size: 16px;
  font-family: 'Outfit-Medium';
  color: #000000;
  flex-wrap: wrap;
  margin-bottom: 2px;
`;

export const Value = styled.Text`
  font-size: 14px;
  font-family: 'Outfit-Regular';
  color: #5a5a5a;
  flex-wrap: wrap;
  line-height: 18px;
`;
