import React from 'react';
import {View, Text} from 'react-native';

const Rewards: React.FC = () => {
  console.log('=== MINIMAL REWARDS COMPONENT LOADED ===');

  return (
    <View
      style={{
        flex: 1,
        justifyContent: 'center',
        alignItems: 'center',
        backgroundColor: 'white',
      }}>
      <Text style={{fontSize: 24, fontWeight: 'bold', color: 'green'}}>
        REWARDS SCREEN LOADED SUCCESSFULLY
      </Text>
      <Text style={{fontSize: 16, marginTop: 20, color: 'blue'}}>
        If you see this, the component loads fine.
      </Text>
      <Text style={{fontSize: 16, marginTop: 10, color: 'blue'}}>
        The crash must be in our complex logic.
      </Text>
    </View>
  );
};

export default Rewards;
