import React, {useEffect, useRef} from 'react';
import {View, Animated, StyleSheet} from 'react-native';

interface CustomBallIndicatorProps {
  size?: number;
  color?: string;
  count?: number;
}

export const CustomBallIndicator: React.FC<CustomBallIndicatorProps> = ({
  size = 40,
  color = '#002118',
  count = 8,
}) => {
  const animatedValues = useRef(
    Array.from({length: count}, () => new Animated.Value(0)),
  ).current;

  useEffect(() => {
    const animations = animatedValues.map((animatedValue, index) => {
      return Animated.sequence([
        Animated.delay(index * 120),
        Animated.loop(
          Animated.sequence([
            Animated.timing(animatedValue, {
              toValue: 1,
              duration: 600,
              useNativeDriver: true,
            }),
            Animated.timing(animatedValue, {
              toValue: 0,
              duration: 600,
              useNativeDriver: true,
            }),
          ]),
        ),
      ]);
    });

    Animated.parallel(animations).start();

    return () => {
      animatedValues.forEach(value => value.stopAnimation());
    };
  }, [animatedValues]);

  const renderBalls = () => {
    const ballSize = size / 5;
    const radius = size / 2 - ballSize / 2;

    return animatedValues.map((animatedValue, index) => {
      const angle = (index * 2 * Math.PI) / count;
      const x = radius * Math.cos(angle);
      const y = radius * Math.sin(angle);

      return (
        <Animated.View
          key={`ball-${index}`}
          style={[
            styles.ball,
            {
              width: ballSize,
              height: ballSize,
              borderRadius: ballSize / 2,
              backgroundColor: color,
              transform: [
                {translateX: x},
                {translateY: y},
                {
                  scale: animatedValue.interpolate({
                    inputRange: [0, 1],
                    outputRange: [0.3, 1],
                  }),
                },
              ],
              opacity: animatedValue.interpolate({
                inputRange: [0, 1],
                outputRange: [0.3, 1],
              }),
            },
          ]}
        />
      );
    });
  };

  return (
    <View style={[styles.container, {width: size, height: size}]}>
      {renderBalls()}
    </View>
  );
};

const styles = StyleSheet.create({
  container: {
    justifyContent: 'center',
    alignItems: 'center',
  },
  ball: {
    position: 'absolute',
  },
});