import React, {useLayoutEffect, useMemo} from 'react';
import {Animated, StyleSheet, View} from 'react-native';

import SealCheck from '../../icons/SealCheck';
import Badges from './Badges';
import {CARD_ART} from './cardArtV2';
import EcashCard from './EcashCard';
import {AMOUNT_H, FINALE_BADGE, type ChargeLayout} from './geometry';
import HoldPill, {type HoldVariant} from './HoldPill';
import Ledger from './Ledger';
import MoneyPool from './MoneyPool';
import {
  changeNeedsMint,
  changeOnCard,
  failureBody,
  onlineOnly,
  parseFailure,
  settleRefused,
  settleUnconfirmed,
  signatureInvalid,
} from './money';
import {friendlyLabel, type StageState} from './phaseToStation';
import StatusBlock, {type StatusShown, type StatusTexts} from './StatusBlock';
import Stepper from './Stepper';
import {CARD, COLOR, DUR, ELEVATION, MAX_FONT_SCALE, TYPE} from './tokens';
import {
  useChargeEngine,
  type Mode,
  type Nodes,
  type PlanShape,
  type Pose,
  type Snapshot,
} from './useChargeEngine';
import {formatSatAmount} from '../../../utils/satCurrency';

/**
 * The stage: runs the engine and the gesture dispatcher, and renders the
 * layers in Android draw order (elevation is draw order there, and Paper
 * flattens layout-only views, so every z-container is collapsable={false}):
 *
 *   ContentLayer (white) — text, ledger, stepper, actions, money pool,
 *                          the card (elevation 12), ornaments (Z13)
 *   SheetWrapper          — the PIN sheet (elevation 16 inside)
 *   Flood                 — the green that becomes Success
 *   FinaleBadge           — the check, above everything
 */
export interface ChargeStageProps {
  layout: ChargeLayout;
  amountSat: number;
  stage: StageState;
  mode: Mode;
  pose: Pose;
  shape: PlanShape | null;
  planKey: string | null;
  last4: string | null;
  pinLength: number;
  /** Mode 'error' in the PIN pose: the pad is the retry. */
  pinError: boolean;
  error: string | null;
  /**
   * The error came after the card burned: the bill is paid
   * (`isPaidFailure`), or the mint refused it (`isRefusedAfterBurn`, titled
   * by its phase). Either way the charge is over.
   */
  paid?: boolean;
  stalled: boolean;
  nfcSupported: boolean | null;
  reduceMotion: boolean;
  timeScale: number;
  resetKey: number;
  iosSession: boolean;
  /** The preview is off screen: loops and timers stop. */
  paused?: boolean;
  header: React.ReactNode;
  actions: {
    idle?: React.ReactNode;
    run?: React.ReactNode;
    err?: React.ReactNode;
  };
  renderSheet?: (sheet: Nodes['sheet'], dots: Nodes['dots']) => React.ReactNode;
  children?: React.ReactNode;
}

export const PAID_TITLE = 'Paid — you can lift the card';
/** The error title of a paid failure (ENG-642) whose change is not on the card. */
export const PAID_CHANGE_NOT_ON_CARD_TITLE = 'Paid — change not on card';
/**
 * The error title of a paid failure with no change (an exact bill), or whose
 * change is on the card (only the payment bookkeeping failed).
 */
export const PAID_FAILURE_TITLE = 'Paid';
/**
 * ENG-674: the card signed, but the mint never confirmed a payment whose
 * pieces could not be checked offline. Not "Paid": they may be forged.
 */
export const UNCONFIRMED_TITLE = 'Not confirmed yet';
/**
 * ENG-674: the card burned and the mint refused the swap for good. Not
 * paid, and the card must not be charged again for this bill.
 */
export const REFUSED_TITLE = 'Not paid — the mint refused it';
/**
 * ENG-674: the card answered with a signature that does not verify. Not
 * paid, nothing reached the mint, and the card must not be charged again.
 */
export const SIGNATURE_INVALID_TITLE =
  "Not paid — the card's signature is not valid";
/**
 * ENG-696: a bill with change, refused before anything burned because the
 * mint is out of reach. The body says nothing was taken.
 */
export const CHANGE_NEEDS_MINT_TITLE = 'Change needs a connection';
/**
 * ENG-696: a card whose pieces cannot be checked offline, refused before
 * anything burned while the terminal is offline.
 */
export const ONLINE_ONLY_TITLE = 'This card is online-only';
export const IDLE_HELPER = 'Then hold the card to the top of the phone';
export const NFC_NOTICE =
  'This phone can’t read cards — turn on NFC in Settings';

function idleTitle(amountSat: number, nfcSupported: boolean | null): string {
  if (nfcSupported === false) {
    return 'Card reading is off';
  }
  return amountSat > 0 ? 'Ready to charge' : 'No amount entered';
}

function ChargeStage(props: ChargeStageProps) {
  const {
    layout: L,
    amountSat,
    stage,
    mode,
    pose,
    shape,
    planKey,
    last4,
    pinLength,
    pinError,
    error,
    paid = false,
    stalled,
    nfcSupported,
    reduceMotion,
    timeScale,
    resetKey,
    iosSession,
    paused = false,
  } = props;
  const engine = useChargeEngine(L, reduceMotion, timeScale, {
    mode,
    pose,
    planKnown: shape !== null,
  });
  const {nodes: n, conductor, titleRing, pillRing, values} = engine;

  // Text slots: decided during render, animated after the commit. The first
  // render and a preview reset place them with no motion.
  const lastResetRef = React.useRef<number | null>(null);
  const instant = lastResetRef.current !== resetKey;
  lastResetRef.current = resetKey;
  let title: string | null;
  let pill: string | null = null;
  if (mode === 'idle') {
    title =
      pose === 'pin'
        ? titleRing.texts[titleRing.active] ?? null
        : idleTitle(amountSat, nfcSupported);
  } else if (mode === 'running') {
    title = friendlyLabel(stage, {changeSat: shape?.changeSat}).title;
    pill = stage.phase;
  } else {
    // complete / error: the slots fade out on F / X; keep their last texts.
    title = titleRing.active >= 0 ? titleRing.texts[titleRing.active] : null;
    pill = pillRing.active >= 0 ? pillRing.texts[pillRing.active] : null;
  }
  titleRing.desire(title, instant);
  pillRing.desire(pill, instant);

  const burnsDone = stage.burnsDone;
  const changeSat = shape?.changeSat ?? 0;
  const texts: StatusTexts = useMemo(() => {
    const failure = parseFailure(error);
    return {
      paidTitle: PAID_TITLE,
      // A paid failure (ENG-642) is headlined as paid, whatever the card
      // said: the title is the big text, and "didn't finish" over a paid
      // body sends the merchant to charge the card again for the same bill.
      // A bookkeeping failure whose change all landed is plain "Paid": the
      // change is on the card (`changeOnCard`).
      errorTitle: paid
        ? signatureInvalid(failure)
          ? SIGNATURE_INVALID_TITLE
          : settleRefused(failure)
          ? REFUSED_TITLE
          : settleUnconfirmed(failure)
          ? UNCONFIRMED_TITLE
          : changeSat > 0 && !changeOnCard(failure)
          ? PAID_CHANGE_NOT_ON_CARD_TITLE
          : PAID_FAILURE_TITLE
        : changeNeedsMint(failure)
        ? CHANGE_NEEDS_MINT_TITLE
        : onlineOnly(failure)
        ? ONLINE_ONLY_TITLE
        : failure.cardFull
        ? 'The card is full'
        : failure.tagLost
        ? 'The card moved away'
        : 'Charge didn’t finish',
      // The pill is the trust surface: the failure exactly as reported.
      errorPhase: error?.trim() || stage.phase || '',
      errorBody: failureBody(failure, {
        burnsDone,
        paidSat: amountSat,
        changeSat,
        paid,
        fmt: formatSatAmount,
      }),
      idleHelper:
        nfcSupported === false
          ? ''
          : amountSat > 0
          ? IDLE_HELPER
          : 'Go back and enter an amount first',
      notice: nfcSupported === false ? NFC_NOTICE : null,
    };
  }, [error, stage.phase, burnsDone, changeSat, paid, nfcSupported, amountSat]);

  const snapshot: Snapshot = {
    mode,
    pose,
    stage,
    stalled,
    shape,
    planKey,
    pinError,
    pinLength,
    resetKey,
    iosSession,
    paused,
  };
  useLayoutEffect(() => {
    conductor.sync(snapshot);
    titleRing.flush(values.title, DUR.text, 'STD', timeScale);
    pillRing.flush(values.pill, 160, 'OUT', timeScale);
  });

  const version = `${titleRing.texts.join('|')}#${
    titleRing.active
  }#${pillRing.texts.join('|')}#${pillRing.active}`;

  // What is the current state, for accessibility: every other pre-mounted
  // layer is hidden from the screen reader, so it hears what is on screen.
  const run = pose === 'run';
  const shownTitle = run && (mode === 'idle' || mode === 'running');
  const shownPill = run && mode === 'running';
  const shownIdle = run && mode === 'idle';
  const shownError = run && mode === 'error';
  const shown: StatusShown = useMemo(
    () => ({
      title: shownTitle,
      pill: shownPill,
      paid: mode === 'complete',
      error: shownError,
      idle: shownIdle,
    }),
    [shownTitle, shownPill, mode, shownError, shownIdle],
  );
  const hold: HoldVariant | null =
    run && mode === 'running'
      ? stage.station === 0
        ? 'w0'
        : stalled
        ? 'stall'
        : 'keep'
      : null;
  const hidden = 'no-hide-descendants' as const;
  const actionSlot = {left: 0, right: 0, top: L.actionTop, height: 56};
  // Its own box (not hung off the action slot), so every dp of the 48 dp
  // hit area is inside its parent — Android hit-tests within bounds only.
  const cancelSlot = {left: 0, right: 0, top: L.cancelTop, height: 48};

  return (
    <View
      style={StyleSheet.absoluteFill}
      collapsable={false}
      pointerEvents="box-none">
      <View
        style={[StyleSheet.absoluteFill, styles.content]}
        collapsable={false}
        pointerEvents="box-none">
        {props.header}
        <Animated.Text
          testID="charge-amount"
          style={[
            TYPE.amount,
            styles.amount,
            {
              left: L.textX,
              width: L.textW,
              top: L.amountTop,
              transform: [{translateY: n.amount.translateY}],
            },
          ]}
          maxFontSizeMultiplier={MAX_FONT_SCALE}
          adjustsFontSizeToFit
          minimumFontScale={0.7}
          numberOfLines={1}>
          {amountSat > 0 ? formatSatAmount(amountSat) : '—'}
        </Animated.Text>
        <Ledger
          layout={L}
          n={n.ledger}
          shape={shape}
          reduceMotion={reduceMotion}
        />
        <Stepper layout={L} n={n.stepper} shape={shape} />
        <StatusBlock
          layout={L}
          n={n.status}
          titleRing={titleRing}
          pillRing={pillRing}
          texts={texts}
          shown={shown}
          version={version}
        />
        <Animated.View
          style={[styles.abs, actionSlot, {opacity: n.actions.opacity}]}
          pointerEvents="box-none">
          {props.actions.idle ? (
            <Animated.View
              testID="actions-idle"
              style={[StyleSheet.absoluteFill, {opacity: n.actions.idle}]}
              importantForAccessibility={
                mode === 'idle' && run ? 'auto' : hidden
              }
              pointerEvents={mode === 'idle' ? 'box-none' : 'none'}>
              {props.actions.idle}
            </Animated.View>
          ) : null}
          {props.actions.err && mode === 'error' ? (
            <Animated.View
              testID="actions-error"
              style={[StyleSheet.absoluteFill, {opacity: n.actions.err}]}
              importantForAccessibility={run ? 'auto' : hidden}
              pointerEvents="box-none">
              {props.actions.err}
            </Animated.View>
          ) : null}
        </Animated.View>
        <MoneyPool
          layout={L}
          n={n.pool}
          shape={shape}
          reduceMotion={reduceMotion}
        />
        <Animated.View
          testID="ecash-card"
          collapsable={false}
          accessible
          accessibilityRole="image"
          accessibilityLabel={
            last4 ? `eCash card ending ${last4}` : 'eCash card'
          }
          style={[
            styles.card,
            {
              left: L.card.x,
              top: L.card.y,
              width: L.card.w,
              height: L.card.h,
              // The art's own ISO corner at this size: a fixed radius
              // would crop the slash's corner or show the base around it.
              borderRadius: CARD_ART.radius * L.card.k,
              opacity: n.card.opacity,
              transform: [
                {translateX: n.card.translateX},
                {translateY: n.card.translateY},
                {scale: n.card.scale},
              ],
            },
          ]}>
          <EcashCard layout={L} n={n.card} last4={last4} />
        </Animated.View>
        <Animated.View
          collapsable={false}
          pointerEvents="none"
          style={[
            StyleSheet.absoluteFill,
            styles.ornaments,
            {
              opacity: n.ornaments.opacity,
              transform: [
                {translateX: n.ornaments.translateX},
                {translateY: n.ornaments.translateY},
              ],
            },
          ]}>
          <HoldPill
            layout={L}
            n={n.hold}
            active={hold}
            reduceMotion={reduceMotion}
          />
          <Badges
            layout={L}
            lock={n.lock}
            errBadge={n.errBadge}
            readBadge={n.readBadge}
            pinErrBadge={n.pinErrBadge}
          />
        </Animated.View>
      </View>
      <Animated.View
        testID="sheet-wrapper"
        collapsable={false}
        importantForAccessibility={pose === 'pin' ? 'auto' : hidden}
        pointerEvents={pose === 'pin' ? 'box-none' : 'none'}
        style={[
          StyleSheet.absoluteFill,
          {
            opacity: n.sheet.opacity,
            transform: [{translateY: n.sheet.translateY}],
          },
        ]}>
        {props.renderSheet ? props.renderSheet(n.sheet, n.dots) : null}
      </Animated.View>
      {/* The running Cancel sits ABOVE the sheet and follows only its own
          presence: on the re-entry from the PIN pose it is there on the
          first running frame while the sheet is still fading out. */}
      {props.actions.run ? (
        <Animated.View
          testID="actions-run"
          collapsable={false}
          style={[styles.abs, cancelSlot, {opacity: n.actions.run}]}
          importantForAccessibility={
            mode === 'running' && run ? 'auto' : hidden
          }
          pointerEvents={mode === 'running' ? 'box-none' : 'none'}>
          {props.actions.run}
        </Animated.View>
      ) : null}
      <Animated.View
        testID="finale-flood"
        pointerEvents="none"
        style={[
          styles.flood,
          {
            left: L.finale.cx - FINALE_BADGE / 2,
            top: L.finale.cy - FINALE_BADGE / 2,
            opacity: n.flood.opacity,
            transform: [{scale: n.flood.scale}],
          },
        ]}
      />
      <Animated.View
        testID="finale-overlay"
        pointerEvents="none"
        style={[
          StyleSheet.absoluteFill,
          styles.overlay,
          {opacity: n.rm.overlay},
        ]}
      />
      <Animated.View
        testID="finale-badge"
        pointerEvents="none"
        style={[
          styles.badge,
          {
            left: L.finale.cx - FINALE_BADGE / 2,
            top: L.finale.cy - FINALE_BADGE / 2,
            opacity: n.badge.opacity,
            transform: [
              {translateY: n.badge.translateY},
              {scale: n.badge.scale},
            ],
          },
        ]}>
        <SealCheck size={50} />
      </Animated.View>
      <Animated.View
        pointerEvents="none"
        style={[
          styles.badge,
          {
            left: L.finale.cx - FINALE_BADGE / 2,
            top: L.finale.successY - FINALE_BADGE / 2,
            opacity: n.rm.badge,
          },
        ]}>
        <SealCheck size={50} />
      </Animated.View>
      {props.children}
    </View>
  );
}

const styles = StyleSheet.create({
  abs: {position: 'absolute'},
  content: {backgroundColor: COLOR.page},
  amount: {position: 'absolute', height: AMOUNT_H, textAlign: 'center'},
  card: {
    position: 'absolute',
    overflow: 'hidden',
    // The art's base: anti-aliased corners never fringe another colour.
    backgroundColor: CARD.base,
    ...ELEVATION.card,
  },
  ornaments: {elevation: 13, zIndex: 13},
  flood: {
    position: 'absolute',
    width: FINALE_BADGE,
    height: FINALE_BADGE,
    borderRadius: FINALE_BADGE / 2,
    backgroundColor: COLOR.green,
  },
  overlay: {backgroundColor: COLOR.green},
  badge: {
    position: 'absolute',
    width: FINALE_BADGE,
    height: FINALE_BADGE,
    borderRadius: FINALE_BADGE / 2,
    backgroundColor: COLOR.white,
    padding: 15,
  },
});

export default ChargeStage;
