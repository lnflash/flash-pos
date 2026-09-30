import React, {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from 'react';
import {Animated, Easing, StyleSheet} from 'react-native';
import styled from 'styled-components/native';

export const COIN_POOL_SIZE = 12;
export const COIN_SIZE = 18;

export interface Point {
  x: number;
  y: number;
}

/**
 * Deterministic fan for the change rain (degrees from straight up, left is
 * negative). A fixed table, not Math.random, so tests and two runs on the
 * same phone look identical.
 */
export const RAIN_ANGLES = [-70, -50, -30, -10, 10, 30, 50, 70];
export const CELEBRATION_ANGLES = [
  -80, -65, -50, -35, -20, -5, 5, 20, 35, 50, 65, 80,
];

export interface CoinPoolHandle {
  /** Park coins on the stage, visible and still (the countable burn coins). */
  seat: (seats: {index: number; at: Point; label?: string}[]) => void;
  /** Fly coin `index` to `to`, shrinking into it at the end (absorbed). */
  fly: (index: number, to: Point, onArrive?: () => void) => void;
  /**
   * Drop straight from `from` to `to`, e.g. a change proof onto the card.
   * `label` replaces whatever `seat` wrote on that coin: a reused index must
   * not fall onto the card still reading the burn amount.
   */
  drop: (index: number, from: Point, to: Point, onLand?: () => void, label?: string) => void;
  /** Burst `angles.length` coins from `origin` in a fan with gravity. */
  burst: (origin: Point, angles: number[], firstIndex?: number) => void;
  /** Hide every coin and stop every animation (mode change / unmount). */
  reset: () => void;
  /** Freeze in place: an error must never move money the service did not. */
  stopAll: () => void;
}

interface Coin {
  pos: Animated.ValueXY;
  scale: Animated.Value;
  opacity: Animated.Value;
  spin: Animated.Value;
  running: Animated.CompositeAnimation | null;
}

const makeCoin = (): Coin => ({
  pos: new Animated.ValueXY({x: 0, y: 0}),
  scale: new Animated.Value(1),
  opacity: new Animated.Value(0),
  spin: new Animated.Value(0),
  running: null,
});

const centre = (p: Point) => ({x: p.x - COIN_SIZE / 2, y: p.y - COIN_SIZE / 2});
const NATIVE = {useNativeDriver: true} as const;

/**
 * A fixed pool of twelve coins that are reused, never mounted per event: the
 * change rain costs zero mounts on the JS thread while the APDU loop runs.
 * Plain Views, not SVG — the coin is the hottest element on the stage and
 * ~24 fewer native SVG nodes is real memory on the old architecture. Only
 * transform and opacity are animated, all on the native driver.
 */
const CoinPool = forwardRef<CoinPoolHandle, {reduceMotion?: boolean}>(
  ({reduceMotion = false}, ref) => {
    const coins = useRef<Coin[]>(
      Array.from({length: COIN_POOL_SIZE}, makeCoin),
    ).current;
    const [labels, setLabels] = useState<string[]>(() =>
      Array(COIN_POOL_SIZE).fill(''),
    );

    const api = useMemo<CoinPoolHandle>(() => {
      const stop = (coin: Coin) => {
        coin.running?.stop();
        coin.running = null;
      };
      const run = (
        coin: Coin,
        anim: Animated.CompositeAnimation,
        onDone?: () => void,
      ) => {
        stop(coin);
        coin.running = anim;
        anim.start(({finished}) => {
          if (coin.running === anim) {
            coin.running = null;
          }
          if (finished) {
            onDone?.();
          }
        });
      };
      return {
        seat: seats => {
          setLabels(prev => {
            const next = [...prev];
            seats.forEach(s => {
              next[s.index] = s.label ?? '';
            });
            return next;
          });
          seats.forEach(({index, at}) => {
            const coin = coins[index];
            if (!coin) {
              return;
            }
            stop(coin);
            coin.pos.setValue(centre(at));
            coin.scale.setValue(1);
            coin.spin.setValue(0);
            coin.opacity.setValue(1);
          });
        },
        fly: (index, to, onArrive) => {
          const coin = coins[index];
          if (!coin) {
            return;
          }
          if (reduceMotion) {
            coin.opacity.setValue(0);
            onArrive?.();
            return;
          }
          coin.opacity.setValue(1);
          run(
            coin,
            Animated.parallel([
              Animated.timing(coin.pos, {
                toValue: centre(to),
                duration: 380,
                easing: Easing.out(Easing.cubic),
                ...NATIVE,
              }),
              Animated.sequence([
                Animated.timing(coin.scale, {toValue: 0.6, duration: 40, ...NATIVE}),
                Animated.timing(coin.scale, {toValue: 1, duration: 220, ...NATIVE}),
                Animated.timing(coin.scale, {toValue: 0, duration: 120, ...NATIVE}),
              ]),
            ]),
            () => {
              coin.opacity.setValue(0);
              onArrive?.();
            },
          );
        },
        drop: (index, from, to, onLand, label = '') => {
          const coin = coins[index];
          if (!coin) {
            return;
          }
          setLabels(prev => (prev[index] === label ? prev : prev.map((l, i) => (i === index ? label : l))));
          if (reduceMotion) {
            onLand?.();
            return;
          }
          coin.pos.setValue(centre(from));
          coin.scale.setValue(1);
          coin.opacity.setValue(1);
          run(
            coin,
            Animated.timing(coin.pos, {
              toValue: centre(to),
              duration: 320,
              easing: Easing.in(Easing.quad),
              ...NATIVE,
            }),
            () => {
              coin.opacity.setValue(0);
              onLand?.();
            },
          );
        },
        burst: (origin, angles, firstIndex = COIN_POOL_SIZE - angles.length) => {
          if (reduceMotion) {
            return;
          }
          angles.forEach((deg, i) => {
            const coin = coins[firstIndex + i];
            if (!coin) {
              return;
            }
            const rad = (deg * Math.PI) / 180;
            const start = centre(origin);
            coin.pos.setValue(start);
            coin.scale.setValue(1);
            coin.spin.setValue(0);
            coin.opacity.setValue(1);
            run(
              coin,
              Animated.sequence([
                Animated.delay(i * 45),
                Animated.parallel([
                  Animated.timing(coin.pos.x, {
                    toValue: start.x + Math.sin(rad) * 92,
                    duration: 600,
                    easing: Easing.out(Easing.quad),
                    ...NATIVE,
                  }),
                  Animated.sequence([
                    Animated.timing(coin.pos.y, {
                      toValue: start.y - 30 * Math.cos(rad) - 10,
                      duration: 220,
                      easing: Easing.out(Easing.quad),
                      ...NATIVE,
                    }),
                    Animated.timing(coin.pos.y, {
                      toValue: start.y + 90,
                      duration: 380,
                      easing: Easing.in(Easing.quad),
                      ...NATIVE,
                    }),
                  ]),
                  Animated.timing(coin.spin, {
                    toValue: 1,
                    duration: 600,
                    easing: Easing.linear,
                    ...NATIVE,
                  }),
                  Animated.sequence([
                    Animated.delay(450),
                    Animated.timing(coin.opacity, {toValue: 0, duration: 150, ...NATIVE}),
                  ]),
                ]),
              ]),
            );
          });
        },
        reset: () => {
          coins.forEach(coin => {
            stop(coin);
            coin.opacity.setValue(0);
            coin.scale.setValue(1);
            coin.spin.setValue(0);
          });
          setLabels(Array(COIN_POOL_SIZE).fill(''));
        },
        stopAll: () => coins.forEach(stop),
      };
    }, [coins, reduceMotion]);

    useImperativeHandle(ref, () => api, [api]);

    // Unmount mid-rain must not leave composites ticking.
    useEffect(() => () => api.stopAll(), [api]);

    return (
      <Animated.View
        pointerEvents="none"
        style={StyleSheet.absoluteFill}
        testID="coin-pool">
        {coins.map((coin, i) => (
          <Animated.View
            key={i}
            style={{
              ...styles.coin,
              opacity: coin.opacity,
              transform: [
                {translateX: coin.pos.x},
                {translateY: coin.pos.y},
                {scale: coin.scale},
                {
                  rotate: coin.spin.interpolate({
                    inputRange: [0, 1],
                    outputRange: ['0deg', '180deg'],
                  }),
                },
              ],
            }}>
            <CoinFace>
              <CoinMark numberOfLines={1}>{labels[i] || 's'}</CoinMark>
            </CoinFace>
          </Animated.View>
        ))}
      </Animated.View>
    );
  },
);

CoinPool.displayName = 'CoinPool';

const styles = StyleSheet.create({
  coin: {position: 'absolute'},
});

export default CoinPool;

const CoinFace = styled.View`
  width: ${COIN_SIZE}px;
  height: ${COIN_SIZE}px;
  border-radius: ${COIN_SIZE / 2}px;
  background-color: #f5b400;
  border-width: 1.5px;
  border-color: #b8860b;
  align-items: center;
  justify-content: center;
`;

const CoinMark = styled.Text`
  font-size: 8px;
  line-height: 10px;
  font-family: 'Outfit-SemiBold';
  color: #7a4f00;
`;
