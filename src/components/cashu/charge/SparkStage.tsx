import React, {useCallback, useEffect, useMemo, useRef} from 'react';
import {AccessibilityInfo, Animated, Dimensions, Easing, StyleSheet} from 'react-native';
import * as Animatable from 'react-native-animatable';
import Svg, {Circle, Ellipse, Path, Rect} from 'react-native-svg';
import styled from 'styled-components/native';

import CoinPool, {
  CELEBRATION_ANGLES,
  COIN_POOL_SIZE,
  RAIN_ANGLES,
  type CoinPoolHandle,
  type Point,
} from './CoinPool';
import {STATION_COUNT, type StageState, type Station} from './phaseToStation';

export type StageMode = 'idle' | 'running' | 'complete' | 'error';

export interface SparkStageProps {
  state: StageState;
  mode: StageMode;
  /** The 90 px strip behind the PIN pad: bolt idling on station 2. */
  docked?: boolean;
  /** No phase for 2.5 s: the "Hold still" pill. */
  stalled?: boolean;
  /** Sat value of each proof about to burn, seated on the card disc. */
  burnCoins?: number[];
  /** From the plan: the running "+N sat" under the change station. */
  changeSat?: number;
  width?: number;
  reduceMotion?: boolean;
}

export const STAGE_HEIGHT = 230;
export const DOCKED_HEIGHT = 90;
const DISC = 44;
const BOLT = 56;
const DIP = 24;
const MAX_SEATED = 6;

const INK = '#1f2328';
const SLATE = '#7a7a8c';
const DIM = '#ececf1';
const RED = '#db254e';
const GOLD = '#f5b400';
const GOLD_DARK = '#b8860b';
const PURPLE = '#6d28d9';
const GREEN = '#007856';
const ERROR_RED = '#b3261e';

const LIT_FILL: Record<number, string> = {1: RED, 2: RED, 3: RED, 4: GOLD, 5: PURPLE};
const LABELS = ['', 'card', 'PIN', 'pay', 'mint', 'change'];
const NATIVE = {useNativeDriver: true} as const;

let reduceMotionCache: boolean | null = null;
/**
 * Read once per app run: a phone held at 40° off-axis is the worst case for
 * motion sickness, so reduce-motion users get crossfades instead of hops.
 */
function useReduceMotion(override?: boolean): boolean {
  const [value, setValue] = React.useState(reduceMotionCache ?? false);
  useEffect(() => {
    if (override !== undefined || reduceMotionCache !== null) {
      return;
    }
    let live = true;
    AccessibilityInfo.isReduceMotionEnabled()
      .then(enabled => {
        reduceMotionCache = enabled;
        if (live) {
          setValue(enabled);
        }
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [override]);
  return override ?? value;
}

/**
 * Station centres on a quadratic curve from 8 % to 92 % of the stage width
 * that dips `dip` px in the middle (a shallow smile) so hops read as arcs.
 * With the control point at mid-width x(t) is linear and y(t) = y0 +
 * 4·dip·t(1−t), which peaks at exactly `dip` on the middle station.
 */
export function stationPoints(width: number, y0: number, dip: number): Point[] {
  const x0 = width * 0.08;
  const x2 = width * 0.92;
  return Array.from({length: STATION_COUNT + 1}, (_, i) => {
    if (i === 0) {
      return {x: x0, y: y0};
    }
    const t = (i - 1) / (STATION_COUNT - 1);
    return {x: x0 + (x2 - x0) * t, y: y0 + 4 * dip * t * (1 - t)};
  });
}

const Glyph = ({kind, color, bg}: {kind: number | 'unlocked' | 'strike'; color: string; bg: string}) => {
  switch (kind) {
    case 1:
      return (
        <>
          <Rect x="2" y="5" width="20" height="14" rx="2.5" fill={color} />
          <Rect x="2" y="8.5" width="20" height="3" fill={bg} />
        </>
      );
    case 2:
      return (
        <>
          <Path d="M8 10V7a4 4 0 0 1 8 0v3" stroke={color} strokeWidth="2.2" fill="none" />
          <Rect x="5" y="10" width="14" height="10" rx="2" fill={color} />
        </>
      );
    case 'unlocked':
      return (
        <>
          <Path d="M16 10V7a4 4 0 0 0-8 0" stroke={color} strokeWidth="2.2" fill="none" />
          <Rect x="5" y="10" width="14" height="10" rx="2" fill={color} />
        </>
      );
    case 3:
      return <Path d="M13 2L4 14h7l-1 8 10-13h-7z" fill={color} />;
    case 4:
      return (
        <>
          <Ellipse cx="12" cy="17" rx="8" ry="3.2" fill={color} />
          <Ellipse cx="12" cy="12" rx="8" ry="3.2" fill={color} stroke={bg} strokeWidth="1" />
          <Ellipse cx="12" cy="7" rx="8" ry="3.2" fill={color} stroke={bg} strokeWidth="1" />
        </>
      );
    case 5:
      return (
        <>
          <Rect x="2" y="7" width="16" height="12" rx="2.5" fill={color} />
          <Rect x="2" y="10" width="16" height="2.5" fill={bg} />
          <Path d="M19 3v7M15.5 6.5h7" stroke={color} strokeWidth="2.2" />
        </>
      );
    case 'strike':
      return <Path d="M5 19L19 5" stroke={color} strokeWidth="2.5" />;
    default:
      return null;
  }
};

const DiscLayer = ({fill, stroke, children}: {fill: string; stroke?: string; children: React.ReactNode}) => (
  <Svg width={DISC} height={DISC} viewBox="0 0 24 24">
    <Circle cx="12" cy="12" r={stroke ? 10.5 : 11.5} fill={fill} stroke={stroke} strokeWidth={stroke ? 1.6 : 0} />
    <Svg x="6" y="6" width="12" height="12" viewBox="0 0 24 24">
      {children}
    </Svg>
  </Svg>
);

/**
 * Every disc is stacked pre-coloured layers whose OPACITY animates: the native
 * driver cannot animate SVG props or colours, and reaching for
 * Animated.createAnimatedComponent(Circle) would drop the whole stage onto
 * the JS thread next to the NFC APDU loop.
 */
const StationDisc = React.memo(
  ({
    n,
    at,
    lit,
    red,
    skipped,
    unlocked,
    pop,
  }: {
    n: number;
    at: Point;
    lit: Animated.Value;
    red: Animated.Value;
    skipped?: Animated.Value;
    unlocked?: Animated.Value;
    pop?: Animated.Value;
  }) => (
    <Animated.View
      style={{
        ...styles.abs,
        left: at.x - DISC / 2,
        top: at.y - DISC / 2,
        width: DISC,
        height: DISC,
        transform: [{scale: pop ?? 1}],
      }}>
      <Layer>
        <DiscLayer fill={DIM}>
          <Glyph kind={n} color={SLATE} bg={DIM} />
        </DiscLayer>
      </Layer>
      <Layer style={{opacity: lit}} testID={`station-${n}-lit`}>
        <DiscLayer fill={LIT_FILL[n]} stroke={n === 4 ? GOLD_DARK : undefined}>
          <Glyph kind={n} color="#ffffff" bg={LIT_FILL[n]} />
        </DiscLayer>
      </Layer>
      {unlocked && (
        <Layer style={{opacity: unlocked}} testID="station-2-unlocked">
          <DiscLayer fill={LIT_FILL[n]}>
            <Glyph kind="unlocked" color="#ffffff" bg={LIT_FILL[n]} />
          </DiscLayer>
        </Layer>
      )}
      {skipped && (
        <Layer style={{opacity: skipped}} testID="station-2-skipped">
          <DiscLayer fill="#ffffff" stroke={SLATE}>
            <Glyph kind={n} color={SLATE} bg="#ffffff" />
            <Glyph kind="strike" color={SLATE} bg="#ffffff" />
          </DiscLayer>
        </Layer>
      )}
      <Layer style={{opacity: red}} testID={`station-${n}-red`}>
        <DiscLayer fill={ERROR_RED}>
          <Glyph kind={n} color="#ffffff" bg={ERROR_RED} />
        </DiscLayer>
      </Layer>
    </Animated.View>
  ),
);
StationDisc.displayName = 'StationDisc';

const useValue = (v: number) => useRef(new Animated.Value(v)).current;

/**
 * Spark Run: the Flash bolt hops five stations (card → PIN → pay → mint →
 * change) on the REAL phases the charge emits, so a child watches a race and
 * an adult reads exactly what the card is doing in the text beneath. All
 * running-phase animation is native-driver transform/opacity; the JS thread
 * (which is also running the APDU loop) only starts composites.
 */
const SparkStage = ({
  state,
  mode,
  docked = false,
  stalled = false,
  burnCoins = [],
  changeSat = 0,
  width = Dimensions.get('screen').width - 40,
  reduceMotion: reduceMotionProp,
}: SparkStageProps) => {
  const reduceMotion = useReduceMotion(reduceMotionProp);
  const height = docked ? DOCKED_HEIGHT : STAGE_HEIGHT;
  const pts = useMemo(
    () => stationPoints(width, docked ? 44 : 112, docked ? 8 : DIP),
    [width, docked],
  );
  const centre = useMemo<Point>(() => ({x: width / 2, y: pts[3].y - 30}), [width, pts]);

  const coins = useRef<CoinPoolHandle>(null);
  const pos = useRef(new Animated.ValueXY({x: 0, y: 0})).current;
  const lift = useValue(0);
  const scaleX = useValue(1);
  const scaleY = useValue(1);
  const pulse = useValue(1);
  const spin = useValue(0);
  const boltOpacity = useValue(1);
  const lit = useRef(Array.from({length: STATION_COUNT + 1}, () => new Animated.Value(0))).current;
  const red = useRef(Array.from({length: STATION_COUNT + 1}, () => new Animated.Value(0))).current;
  const skipped = useValue(0);
  const unlocked = useValue(0);
  const cardPop = useValue(1);
  const changePop = useValue(1);
  const orbit = useValue(0);
  const orbitOpacity = useValue(0);
  const mintScale = useValue(1);
  const scan = useValue(0);
  const ringScale = useValue(0.4);
  const ringOpacity = useValue(0);
  const shock = useValue(0);

  const stateRef = useRef(state);
  stateRef.current = state;
  const dockedRef = useRef(docked);
  dockedRef.current = docked;
  const boltStation = useRef<Station>(1);
  const boltAnim = useRef<Animated.CompositeAnimation | null>(null);
  /**
   * The position-dependent work of the hop in flight (coin fly, mint orbit).
   * A hop that is interrupted — by the next phase, by the PIN pad undocking,
   * by a fast reject — must still do it, or a burn coin stays seated on the
   * card while the bolt moves on. Cleared (dropped) on a mode change.
   */
  const landing = useRef<(() => void) | null>(null);
  const pulseAnim = useRef<Animated.CompositeAnimation | null>(null);
  const loops = useRef<Animated.CompositeAnimation[]>([]);
  const extras = useRef<Animated.CompositeAnimation[]>([]);
  const crossfadeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const boltTopLeft = useCallback(
    (p: Point): Point => ({x: p.x - BOLT / 2, y: p.y - BOLT / 2 - 6}),
    [],
  );
  const boltCentre = useCallback((n: Station): Point => ({x: pts[n].x, y: pts[n].y - 6}), [pts]);

  const flushLanding = useCallback(() => {
    const land = landing.current;
    landing.current = null;
    land?.();
  }, []);

  const stopAll = useCallback(() => {
    landing.current = null;
    boltAnim.current?.stop();
    boltAnim.current = null;
    if (crossfadeTimer.current) {
      clearTimeout(crossfadeTimer.current);
      crossfadeTimer.current = null;
    }
    pulseAnim.current?.stop();
    pulseAnim.current = null;
    loops.current.forEach(l => l.stop());
    loops.current = [];
    extras.current.forEach(a => a.stop());
    extras.current = [];
  }, []);

  const startLoop = useCallback((anim: Animated.CompositeAnimation) => {
    loops.current.push(anim);
    anim.start();
  }, []);
  const startExtra = useCallback((anim: Animated.CompositeAnimation, onDone?: () => void) => {
    extras.current.push(anim);
    anim.start(({finished}) => {
      extras.current = extras.current.filter(a => a !== anim);
      if (finished) {
        onDone?.();
      }
    });
  }, []);

  /** Snap the bolt onto a station: any hop in flight lands here, now. */
  const park = useCallback(
    (n: Station) => {
      boltAnim.current?.stop();
      boltAnim.current = null;
      boltStation.current = n;
      pos.setValue(boltTopLeft(pts[n]));
      lift.setValue(0);
      scaleX.setValue(1);
      scaleY.setValue(1);
      spin.setValue(0);
      boltOpacity.setValue(1);
      flushLanding();
    },
    [pts, pos, lift, scaleX, scaleY, spin, boltOpacity, boltTopLeft, flushLanding],
  );

  // A fade that finishes is pinned to exactly 1: stopping a native timing
  // leaves the value wherever it was, so every later snap compares against a
  // known state (and the lit state is observable where the driver is stubbed).
  const light = useCallback(
    (n: Station) =>
      startExtra(
        Animated.timing(lit[n], {toValue: 1, duration: 240, easing: Easing.out(Easing.quad), ...NATIVE}),
        () => lit[n].setValue(1),
      ),
    [lit, startExtra],
  );

  /**
   * Every station up to `n` lit instantly, honouring a skipped PIN. Used
   * wherever an animation could have been cut short: a re-park after the
   * PIN pad undocks, and the error freeze.
   */
  const snapLights = useCallback(
    (n: Station) => {
      const skip = stateRef.current.pinSkipped;
      for (let i = 1; i <= n; i += 1) {
        if (i === 2 && skip) {
          skipped.setValue(1);
        } else {
          lit[i].setValue(1);
        }
      }
      if (n > 2 && !skip) {
        unlocked.setValue(1);
      }
    },
    [lit, skipped, unlocked],
  );

  /** The thump: a still hand must never see a still screen, even between hops. */
  const thump = useCallback(
    (peak = 1.14) => {
      pulseAnim.current?.stop();
      const anim = Animated.sequence([
        Animated.timing(pulse, {toValue: peak, duration: 90, ...NATIVE}),
        Animated.spring(pulse, {toValue: 1, friction: 4, tension: 160, ...NATIVE}),
      ]);
      pulseAnim.current = anim;
      anim.start();
    },
    [pulse],
  );

  const bounce = useCallback(
    (times: number, depth = -10) => {
      // A bounce is in place: a hop still in flight lands first, so the bolt
      // never bobs mid-arc between stations.
      park(boltStation.current);
      const hops: Animated.CompositeAnimation[] = [];
      for (let i = 0; i < times; i += 1) {
        hops.push(
          Animated.timing(lift, {toValue: depth, duration: 160, easing: Easing.out(Easing.quad), ...NATIVE}),
          Animated.timing(lift, {toValue: 0, duration: 160, easing: Easing.in(Easing.quad), ...NATIVE}),
        );
      }
      const anim = Animated.sequence(hops);
      boltAnim.current = anim;
      anim.start();
    },
    [lift, park],
  );

  /**
   * ONE hop straight to the target, however many stations away: hops are
   * never queued, so the bolt cannot lag behind reality. Any previous hop is
   * stopped and the new one starts from the current value.
   */
  const hopTo = useCallback(
    (target: Point, onLand?: () => void, far = false) => {
      boltAnim.current?.stop();
      // The landing snaps the JS-side values to the destination: the native
      // driver never writes back, so without this the next park/hop would
      // reason from a stale origin.
      const land = () => {
        pos.setValue(target);
        lift.setValue(0);
        scaleX.setValue(1);
        scaleY.setValue(1);
        boltOpacity.setValue(1);
        if (landing.current === onLand) {
          landing.current = null;
        }
        onLand?.();
      };
      landing.current = onLand ?? null;
      if (reduceMotion) {
        const anim = Animated.sequence([
          Animated.timing(boltOpacity, {toValue: 0, duration: 100, ...NATIVE}),
          Animated.timing(boltOpacity, {toValue: 1, duration: 100, ...NATIVE}),
        ]);
        boltAnim.current = anim;
        anim.start(({finished}) => finished && land());
        if (crossfadeTimer.current) {
          clearTimeout(crossfadeTimer.current);
        }
        crossfadeTimer.current = setTimeout(() => {
          crossfadeTimer.current = null;
          pos.setValue(target);
        }, 100);
        return;
      }
      const flight = far ? 560 : 420;
      const anim = Animated.sequence([
        Animated.parallel([
          Animated.timing(pos, {toValue: target, duration: flight, easing: Easing.linear, ...NATIVE}),
          Animated.sequence([
            Animated.timing(lift, {toValue: -38, duration: flight * 0.48, easing: Easing.out(Easing.quad), ...NATIVE}),
            Animated.timing(lift, {toValue: 0, duration: flight * 0.52, easing: Easing.in(Easing.quad), ...NATIVE}),
          ]),
        ]),
        Animated.parallel([
          Animated.timing(scaleY, {toValue: 0.82, duration: 70, ...NATIVE}),
          Animated.timing(scaleX, {toValue: 1.18, duration: 70, ...NATIVE}),
        ]),
        Animated.parallel([
          Animated.spring(scaleY, {toValue: 1, friction: 4, tension: 160, ...NATIVE}),
          Animated.spring(scaleX, {toValue: 1, friction: 4, tension: 160, ...NATIVE}),
        ]),
      ]);
      boltAnim.current = anim;
      anim.start(({finished}) => finished && land());
    },
    [reduceMotion, pos, lift, scaleX, scaleY, boltOpacity],
  );

  /**
   * Lighting a station is a fact about the charge, not about the bolt's
   * flight, so every station the hop passes lights as the hop STARTS; only
   * position-dependent work (coin fly, orbit) waits for `onLand`.
   */
  const hopToStation = useCallback(
    (n: Station, onLand?: () => void) => {
      const from = boltStation.current;
      for (let i = from + 1; i <= n; i += 1) {
        if (!(i === 2 && stateRef.current.pinSkipped)) {
          light(i as Station);
        }
      }
      if (from === n) {
        onLand?.();
        return;
      }
      boltStation.current = n;
      hopTo(boltTopLeft(pts[n]), onLand, n - from > 1);
    },
    [hopTo, boltTopLeft, pts, light],
  );

  const stopOrbit = useCallback(() => {
    loops.current.forEach(l => l.stop());
    loops.current = [];
    orbit.setValue(0);
    mintScale.setValue(1);
    orbitOpacity.setValue(0);
  }, [orbit, mintScale, orbitOpacity]);

  const startOrbit = useCallback(() => {
    orbitOpacity.setValue(1);
    if (reduceMotion) {
      return;
    }
    startLoop(
      Animated.loop(
        Animated.timing(orbit, {toValue: 1, duration: 1400, easing: Easing.linear, ...NATIVE}),
      ),
    );
    startLoop(
      Animated.loop(
        Animated.sequence([
          Animated.timing(mintScale, {toValue: 1.06, duration: 350, easing: Easing.inOut(Easing.quad), ...NATIVE}),
          Animated.timing(mintScale, {toValue: 1, duration: 350, easing: Easing.inOut(Easing.quad), ...NATIVE}),
        ]),
      ),
    );
  }, [reduceMotion, orbit, mintScale, orbitOpacity, startLoop]);

  const popDisc = useCallback(
    (value: Animated.Value) =>
      startExtra(
        Animated.sequence([
          Animated.timing(value, {toValue: 1.18, duration: 60, ...NATIVE}),
          Animated.spring(value, {toValue: 1, friction: 4, tension: 200, ...NATIVE}),
        ]),
      ),
    [startExtra],
  );

  const resetLights = useCallback(() => {
    lit.forEach(v => v.setValue(0));
    red.forEach(v => v.setValue(0));
    skipped.setValue(0);
    unlocked.setValue(0);
    cardPop.setValue(1);
    changePop.setValue(1);
    scan.setValue(0);
    ringOpacity.setValue(0);
    ringScale.setValue(0.4);
    shock.setValue(0);
    pulse.setValue(1);
    stopOrbit();
  }, [lit, red, skipped, unlocked, cardPop, changePop, scan, ringOpacity, ringScale, shock, pulse, stopOrbit]);

  // Seat the countable burn coins on the card disc whenever a plan is known.
  useEffect(() => {
    if (mode === 'complete' || mode === 'error') {
      return;
    }
    const pool = coins.current;
    if (!pool) {
      return;
    }
    pool.reset();
    const k = Math.min(burnCoins.length, MAX_SEATED);
    if (k === 0) {
      return;
    }
    pool.seat(
      burnCoins.slice(0, k).map((amount, i) => ({
        index: i,
        at: {x: pts[1].x + (i - (k - 1) / 2) * 16, y: pts[1].y - 34},
        label: String(amount),
      })),
    );
  }, [burnCoins, pts, mode]);

  // Scene per mode. Every loop started here is stopped by the cleanup, so a
  // jest unmount under fake timers never hangs on a leaked composite.
  useEffect(() => {
    stopAll();
    coins.current?.stopAll();
    if (mode === 'idle') {
      resetLights();
      park(dockedRef.current ? 2 : 1);
      if (dockedRef.current) {
        lit[1].setValue(1);
      }
      if (!reduceMotion) {
        startLoop(
          Animated.loop(
            Animated.sequence([
              Animated.timing(lift, {toValue: -14, duration: 700, easing: Easing.inOut(Easing.quad), ...NATIVE}),
              Animated.timing(lift, {toValue: 0, duration: 700, easing: Easing.inOut(Easing.quad), ...NATIVE}),
            ]),
          ),
        );
      }
    } else if (mode === 'running') {
      if (stateRef.current.station === 0) {
        resetLights();
        park(1);
      }
    } else if (mode === 'error') {
      // The failed station stays red and the bolt stays parked until the
      // merchant re-taps: "it was loading your change — tap once more" is
      // readable off the screen. Coins freeze where the money actually is.
      // stopAll() above only halts composites where they are, so the bolt is
      // snapped onto the station it was heading for and every passed station
      // is pinned fully lit before the red blink goes on top.
      const n = Math.max(stateRef.current.station, 1) as Station;
      park(boltStation.current);
      snapLights(n);
      stopOrbit();
      startExtra(
        Animated.sequence([
          Animated.timing(red[n], {toValue: 1, duration: 160, ...NATIVE}),
          Animated.timing(red[n], {toValue: 0, duration: 160, ...NATIVE}),
          Animated.timing(red[n], {toValue: 1, duration: 160, ...NATIVE}),
          Animated.timing(red[n], {toValue: 0, duration: 160, ...NATIVE}),
          Animated.timing(red[n], {toValue: 1, duration: 160, ...NATIVE}),
        ]),
      );
    } else if (mode === 'complete') {
      stopOrbit();
      const celebrate = () => {
        lit.forEach((v, i) => i > 0 && v.setValue(1));
        pulseAnim.current?.stop();
        const grow = Animated.spring(pulse, {toValue: 1.5, friction: 5, tension: 120, ...NATIVE});
        pulseAnim.current = grow;
        // Only a FINISHED grow starts the breathing loop: a stop() from the
        // mode-change cleanup also fires this callback, and starting a loop
        // there would leak it past unmount.
        grow.start(({finished}) => {
          if (!finished || reduceMotion) {
            return;
          }
          startLoop(
            Animated.loop(
              Animated.sequence([
                Animated.timing(pulse, {toValue: 1.58, duration: 700, easing: Easing.inOut(Easing.quad), ...NATIVE}),
                Animated.timing(pulse, {toValue: 1.5, duration: 700, easing: Easing.inOut(Easing.quad), ...NATIVE}),
              ]),
            ),
          );
        });
        ringScale.setValue(0.4);
        ringOpacity.setValue(0.9);
        startExtra(
          Animated.parallel([
            Animated.timing(ringScale, {toValue: 2.2, duration: 550, easing: Easing.out(Easing.quad), ...NATIVE}),
            Animated.timing(ringOpacity, {toValue: 0, duration: 550, ...NATIVE}),
            Animated.spring(shock, {toValue: 1, friction: 8, tension: 30, ...NATIVE}),
          ]),
        );
        coins.current?.burst(centre, CELEBRATION_ANGLES, 0);
      };
      boltStation.current = 3;
      hopTo(boltTopLeft(centre), celebrate, true);
    }
    return stopAll;
  }, [mode, reduceMotion]); // eslint-disable-line react-hooks/exhaustive-deps

  // Geometry, separately from the scene: when the PIN pad undocks 260 ms
  // into the second tap the track jumps ~70 px, and 'reading card' has
  // usually already landed. Re-running the scene would stopAll() and leave
  // lights half-faded; this only re-seats the bolt and pins what is lit.
  useEffect(() => {
    if (mode === 'idle') {
      park(docked ? 2 : 1);
      if (docked) {
        lit[1].setValue(1);
      }
    } else if (mode === 'running' && stateRef.current.station > 0) {
      park(boltStation.current);
      snapLights(stateRef.current.station);
    }
  }, [pts]); // eslint-disable-line react-hooks/exhaustive-deps

  // Choreography per phase, keyed on seq so repeated strings still fire.
  useEffect(() => {
    if (mode !== 'running' || state.seq === 0) {
      return;
    }
    // Reality moved on: whatever the previous hop was going to do on landing
    // happens now, BEFORE this phase's own stop/start calls, so e.g. an
    // orbit that never got to start is started and then cleanly stopped.
    flushLanding();
    const pool = coins.current;
    switch (state.event) {
      case 'hello':
        light(1);
        bounce(2);
        thump();
        break;
      case 'hop':
        if (state.station === 2) {
          hopToStation(2, () =>
            startExtra(Animated.timing(unlocked, {toValue: 1, duration: 200, ...NATIVE}), () =>
              unlocked.setValue(1),
            ),
          );
        } else {
          hopToStation(state.station);
        }
        thump();
        break;
      case 'burn': {
        if (state.pinSkipped) {
          skipped.setValue(1);
        }
        const coinIndex = (state.burn?.index ?? 1) - 1;
        const flyCoin = () => {
          if (coinIndex < MAX_SEATED) {
            pool?.fly(coinIndex, boltCentre(3), () => thump(1.12));
          } else {
            thump(1.12);
          }
        };
        if (boltStation.current !== 3) {
          hopToStation(3, flyCoin);
        } else {
          flyCoin();
        }
        thump();
        break;
      }
      case 'orbit':
        hopToStation(4, startOrbit);
        thump();
        break;
      case 'change': {
        stopOrbit();
        // The drop reuses low pool indices that `seat` labelled with the burn
        // amounts; a change coin must never read as the sat value just burned.
        const dropIndex = (state.changeWritten - 1) % (COIN_POOL_SIZE - RAIN_ANGLES.length);
        const rain = () => {
          if (state.changeWritten === 1) {
            pool?.burst(pts[4], RAIN_ANGLES);
          }
          pool?.drop(dropIndex, pts[4], pts[1], () => popDisc(cardPop), '');
        };
        if (boltStation.current !== 5) {
          hopToStation(5, rain);
        } else {
          rain();
        }
        thump();
        break;
      }
      case 'scan':
        stopOrbit();
        // The bounce waits for the landing: bounce() parks first, so starting
        // it on the same tick would cut the hop short on the exact-bill and
        // deferred-offline paths (station 4 → 5 here, not earlier).
        hopToStation(5, () => {
          if (state.exact) {
            popDisc(changePop);
          }
          bounce(2);
        });
        scan.setValue(0);
        startExtra(Animated.timing(scan, {toValue: 1, duration: 480, easing: Easing.inOut(Easing.quad), ...NATIVE}));
        thump();
        break;
      case 'spin':
        spin.setValue(0);
        startExtra(
          Animated.timing(spin, {toValue: 1, duration: 600, easing: Easing.inOut(Easing.quad), ...NATIVE}),
          () => spin.setValue(0),
        );
        thump(1.06);
        break;
      default:
        thump();
    }
  }, [state.seq]); // eslint-disable-line react-hooks/exhaustive-deps

  const label =
    mode === 'complete'
      ? 'paid, you can lift the card'
      : state.station > 0
      ? `step ${state.station} of ${STATION_COUNT}, ${state.phase ?? ''}`
      : 'waiting for card';

  const track = `M${pts[1].x} ${pts[1].y} Q${width / 2} ${pts[1].y + (docked ? 16 : DIP * 2)} ${pts[5].x} ${pts[5].y}`;
  const shockScale = shock.interpolate({inputRange: [0, 1], outputRange: [0, (Math.hypot(width, height) + 40) / 80]});
  const burnTotal = state.burn?.total ?? 0;

  return (
    <Stage style={{width, height}} testID="spark-stage">
      {mode === 'idle' && !docked && !reduceMotion && (
        <Layer pointerEvents="none" testID="idle-ripples">
          {[0, 1, 2].map(i => (
            <Ring
              key={i}
              style={{left: pts[1].x - 50, top: pts[1].y - 50 - 24}}
              animation="zoomOut"
              duration={1900}
              delay={i * 620}
              iterationCount="infinite"
              easing="ease-out"
              useNativeDriver
            />
          ))}
        </Layer>
      )}

      <Svg width={width} height={height} style={absolute}>
        <Path d={track} stroke={DIM} strokeWidth="6" fill="none" strokeLinecap="round" />
      </Svg>

      {([1, 2, 3, 4, 5] as Station[]).map(n => (
        <StationDisc
          key={n}
          n={n}
          at={pts[n]}
          lit={lit[n]}
          red={red[n]}
          skipped={n === 2 ? skipped : undefined}
          unlocked={n === 2 ? unlocked : undefined}
          pop={n === 1 ? cardPop : n === 4 ? mintScale : n === 5 ? changePop : undefined}
        />
      ))}

      {!docked && (
        <>
          {LABELS.slice(1).map((text, i) => (
            <DiscLabel key={text} style={{left: pts[i + 1].x - 30, top: pts[i + 1].y + DISC / 2 + 4}}>
              {text}
            </DiscLabel>
          ))}
          {burnTotal > 0 && (
            <Pips style={{left: pts[3].x - 30, top: pts[3].y + DISC / 2 + 20}} testID="burn-pips">
              {Array.from({length: burnTotal}).map((_, i) => (
                <Pip key={i} filled={i < state.burnsDone} />
              ))}
            </Pips>
          )}
          {(state.exact || changeSat > 0) && mode !== 'idle' && (
            <ChangeNote
              style={{left: pts[5].x - 36, top: pts[5].y + DISC / 2 + 20}}
              lit={state.station === 5}
              testID="change-note">
              {state.exact ? 'exact' : `+${changeSat} sat`}
            </ChangeNote>
          )}
        </>
      )}

      {/* Mint orbit: three coins at radius 34 on a rotating view. */}
      <Animated.View
        pointerEvents="none"
        testID="mint-orbit"
        style={{
          ...styles.orbit,
          left: pts[4].x - 34,
          top: pts[4].y - 34,
          opacity: orbitOpacity,
          transform: [{rotate: orbit.interpolate({inputRange: [0, 1], outputRange: ['0deg', '360deg']})}],
        }}>
        {reduceMotion ? (
          <StaticRing />
        ) : (
          [0, 120, 240].map(deg => (
            <OrbitCoin
              key={deg}
              style={{
                left: 34 + Math.sin((deg * Math.PI) / 180) * 34 - 7,
                top: 34 - Math.cos((deg * Math.PI) / 180) * 34 - 7,
              }}
            />
          ))
        )}
      </Animated.View>

      {/* Scan-line sweep across the card disc on the final balance read. */}
      <Animated.View
        pointerEvents="none"
        style={{
          ...styles.scan,
          left: pts[1].x - 2,
          top: pts[1].y - DISC / 2,
          opacity: scan.interpolate({inputRange: [0, 0.15, 0.85, 1], outputRange: [0, 0.9, 0.9, 0]}),
          transform: [{translateX: scan.interpolate({inputRange: [0, 1], outputRange: [-DISC / 2, DISC / 2]})}],
        }}
      />

      {/* Green shockwave, clipped to the stage so the text below stays legible. */}
      <Clip pointerEvents="none">
        <Animated.View
          style={{
            ...styles.shock,
            left: centre.x - 40,
            top: centre.y - 40,
            transform: [{scale: shockScale}],
          }}
        />
      </Clip>

      <Animated.View
        pointerEvents="none"
        style={{
          ...styles.abs,
          left: centre.x - 30,
          top: centre.y - 30,
          opacity: ringOpacity,
          transform: [{scale: ringScale}],
        }}>
        <Svg width={60} height={60} viewBox="0 0 60 60">
          <Circle cx="30" cy="30" r="28" stroke={GREEN} strokeWidth="2" fill="none" />
        </Svg>
      </Animated.View>

      <CoinPool ref={coins} reduceMotion={reduceMotion} />

      <Animated.View
        accessible
        accessibilityLabel={label}
        testID="spark-bolt"
        style={{
          ...styles.bolt,
          opacity: boltOpacity,
          transform: [
            {translateX: pos.x},
            {translateY: Animated.add(pos.y, lift)},
            {scaleX: Animated.multiply(scaleX, pulse)},
            {scaleY: Animated.multiply(scaleY, pulse)},
            {rotate: spin.interpolate({inputRange: [0, 1], outputRange: ['0deg', '360deg']})},
          ],
        }}>
        <Svg width={BOLT} height={BOLT} viewBox="0 0 24 24">
          <Path d="M13 2L4 14h7l-1 8 10-13h-7z" fill={RED} stroke={INK} strokeWidth="0.9" strokeLinejoin="round" />
        </Svg>
      </Animated.View>

      {stalled && mode === 'running' && (
        <Animatable.View
          animation={reduceMotion ? undefined : 'swing'}
          iterationCount={reduceMotion ? 1 : 'infinite'}
          duration={900}
          useNativeDriver
          style={styles.pillWrap}>
          <Pill testID="hold-still-pill">
            <PillText>Hold still — almost there</PillText>
          </Pill>
        </Animatable.View>
      )}
    </Stage>
  );
};

export default SparkStage;

/**
 * The 6 px rail under the phase text. scaleX from the left edge, faked with
 * a translateX so the whole thing stays on the native driver.
 */
export const ProgressRail = ({progress, width = Dimensions.get('screen').width - 40}: {progress: number; width: number}) => {
  const value = useRef(new Animated.Value(progress)).current;
  useEffect(() => {
    const anim = Animated.timing(value, {toValue: progress, duration: 400, easing: Easing.out(Easing.quad), ...NATIVE});
    anim.start();
    return () => anim.stop();
  }, [progress, value]);
  return (
    <RailTrack style={{width}} testID="progress-rail">
      <Animated.View
        style={{
          ...styles.railFill,
          width,
          transform: [
            {translateX: value.interpolate({inputRange: [0, 1], outputRange: [-width / 2, 0]})},
            {scaleX: value},
          ],
        }}
      />
    </RailTrack>
  );
};

const absolute = {position: 'absolute' as const, left: 0, top: 0};

const styles = StyleSheet.create({
  abs: {position: 'absolute'},
  orbit: {position: 'absolute', width: 68, height: 68},
  scan: {position: 'absolute', width: 4, height: DISC, borderRadius: 2, backgroundColor: '#ffffff'},
  shock: {position: 'absolute', width: 80, height: 80, borderRadius: 40, backgroundColor: GREEN},
  bolt: {position: 'absolute', width: BOLT, height: BOLT},
  pillWrap: {position: 'absolute', top: 10, left: 0, right: 0, alignItems: 'center'},
  railFill: {height: 6, borderRadius: 3, backgroundColor: RED},
});

const Stage = styled.View`
  align-self: center;
  overflow: visible;
`;

const Layer = styled(Animated.View)`
  position: absolute;
  left: 0;
  top: 0;
  right: 0;
  bottom: 0;
`;

const Clip = styled.View`
  position: absolute;
  left: 0;
  top: 0;
  right: 0;
  bottom: 0;
  overflow: hidden;
  border-radius: 20px;
`;

const Ring = styled(Animatable.View)`
  position: absolute;
  width: 100px;
  height: 100px;
  border-radius: 50px;
  border-width: 2px;
  border-color: ${RED};
`;

const DiscLabel = styled.Text`
  position: absolute;
  width: 60px;
  text-align: center;
  font-size: 11px;
  font-family: 'Outfit-Medium';
  color: ${SLATE};
`;

const Pips = styled.View`
  position: absolute;
  width: 60px;
  flex-direction: row;
  justify-content: center;
`;

const Pip = styled.View<{filled: boolean}>`
  width: 6px;
  height: 6px;
  border-radius: 3px;
  margin-horizontal: 2px;
  background-color: ${p => (p.filled ? RED : DIM)};
`;

const ChangeNote = styled.Text<{lit: boolean}>`
  position: absolute;
  width: 72px;
  text-align: center;
  font-size: 12px;
  font-family: 'Outfit-SemiBold';
  color: ${p => (p.lit ? PURPLE : SLATE)};
`;

const OrbitCoin = styled.View`
  position: absolute;
  width: 14px;
  height: 14px;
  border-radius: 7px;
  background-color: ${GOLD};
  border-width: 1.5px;
  border-color: ${GOLD_DARK};
`;

const StaticRing = styled.View`
  width: 68px;
  height: 68px;
  border-radius: 34px;
  border-width: 3px;
  border-color: ${GOLD};
`;

const Pill = styled.View`
  height: 32px;
  padding-horizontal: 14px;
  border-radius: 16px;
  background-color: ${INK};
  justify-content: center;
`;

const PillText = styled.Text`
  font-size: 14px;
  font-family: 'Outfit-SemiBold';
  color: #ffffff;
`;

const RailTrack = styled.View`
  height: 6px;
  border-radius: 3px;
  background-color: ${DIM};
  overflow: hidden;
  align-self: center;
  margin-top: 12px;
`;
