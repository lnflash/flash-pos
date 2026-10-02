import {Platform, type TextStyle, type ViewStyle} from 'react-native';

/**
 * The charge screen's visual system. One accent (brand green), one ink and
 * red for errors only — the screen reads as a receipt being written, not a
 * game. The customer's card is the one object in its own colours (CARD).
 */
export const COLOR = {
  /** All primary text, the amount, the FROM-filled chip. */
  ink: '#002118',
  /** The ONLY positive colour: progress, paid, the check, the flood. */
  green: '#007856',
  greenTint: '#e6f2ed',
  page: '#ffffff',
  chipPending: '#f8f9fa',
  pill: '#f1f3f5',
  hairline: '#e3e6ea',
  track: '#e6e8ec',
  /** 6.1:1 on white — secondary text that must be read. */
  text2: '#5f6270',
  /** 3.4:1 — only at 20 sp SemiBold (large-text AA). */
  pendingNum: '#858b98',
  /** 9.3:1 on the verbatim pill. */
  pillText: '#3b4250',
  /** Decoration and disabled states only — never text that must be read. */
  decorGrey: '#9292a0',
  disabledGrey: '#c6c6d0',
  /**
   * Errors only: the failed segment, the error badge, the error dot, the
   * error title and the PIN sheet's reason (4.8:1 on white — AA at any
   * size). One red on the whole screen.
   */
  red: '#db254e',
  noteBorder: '#dfe3e8',
  white: '#ffffff',
  slipBorder: 'rgba(0,120,86,0.24)',
} as const;

/**
 * The eCash card: Flash Card v2 "Bearer" — matte near-black, one Bitcoin
 * orange accent, a satin-gold chip, and no green (Flash green is the app's).
 * The face itself is drawn by cardArtV2.tsx, which is shared byte-for-byte
 * with flash-mobile and owns these values (a test pins this copy to it);
 * the stage uses them for the card's container, overlays and finale dim.
 */
export const CARD = {
  base: '#080a0d',
  orange: '#f97316',
  goldShadow: '#805711',
  goldLow: '#a88232',
  goldLight: '#bc933a',
  goldMid: '#b6862f',
  goldDark: '#a5761c',
  chipLine: '#8a6524',
  lift: '#d8b8ff',
  watermark: '#f5c96b',
  nfcGrey: '#8b8f96',
  /** The masked id: 60 % white, visibly quieter than the FLASH wordmark. */
  id: 'rgba(255,255,255,0.6)',
  /** The finale dim recedes to black, never to teal. */
  dim: '#000000',
  shadow: '#000000',
} as const;

/** Every Text on the stage: no font padding, centred, capped scaling. */
const base: TextStyle = {
  includeFontPadding: false,
  textAlignVertical: 'center',
};

export const MAX_FONT_SCALE = 1.15;

export const TYPE = {
  amount: {
    ...base,
    fontFamily: 'Outfit-SemiBold',
    fontSize: 52,
    lineHeight: 60,
    letterSpacing: -0.5,
    color: COLOR.ink,
  },
  title: {
    ...base,
    fontFamily: 'Outfit-SemiBold',
    fontSize: 20,
    lineHeight: 26,
    color: COLOR.ink,
  },
  paidTitle: {
    ...base,
    fontFamily: 'Outfit-SemiBold',
    fontSize: 22,
    lineHeight: 28,
    color: COLOR.green,
  },
  errorTitle: {
    ...base,
    fontFamily: 'Outfit-SemiBold',
    fontSize: 20,
    lineHeight: 26,
    color: COLOR.red,
  },
  helper: {
    ...base,
    fontFamily: 'Outfit-Medium',
    fontSize: 15,
    lineHeight: 20,
    color: COLOR.text2,
  },
  pill: {
    ...base,
    fontFamily: 'Outfit-Medium',
    fontSize: 13,
    lineHeight: 18,
    color: COLOR.pillText,
  },
  hold: {
    ...base,
    fontFamily: 'Outfit-Medium',
    fontSize: 13,
    lineHeight: 16,
    color: COLOR.ink,
  },
  chipNumber: {
    ...base,
    fontFamily: 'Outfit-SemiBold',
    fontSize: 20,
    lineHeight: 24,
  },
  chipCaption: {
    ...base,
    fontFamily: 'Outfit-SemiBold',
    fontSize: 11,
    lineHeight: 14,
    letterSpacing: 0.6,
    color: COLOR.text2,
  },
  note: {
    ...base,
    fontFamily: 'Outfit-SemiBold',
    fontSize: 15,
    lineHeight: 18,
    color: COLOR.ink,
  },
  /** The masked id on the card face, "•••• 0C67": never a printed number. */
  cardId: {
    ...base,
    fontFamily: 'Outfit-Medium',
    fontSize: 12,
    lineHeight: 16,
    letterSpacing: 1.5,
    color: CARD.id,
    textAlign: 'right' as const,
  },
  header: {
    ...base,
    fontFamily: 'Outfit-Bold',
    fontSize: 20,
    lineHeight: 24,
    color: COLOR.ink,
  },
  sheetTitle: {
    ...base,
    fontFamily: 'Outfit-SemiBold',
    fontSize: 20,
    lineHeight: 26,
    color: COLOR.ink,
  },
  pinKey: {
    ...base,
    fontFamily: 'Outfit-Medium',
    fontSize: 28,
    lineHeight: 34,
    color: COLOR.ink,
  },
  textButton: {
    ...base,
    fontFamily: 'Outfit-Medium',
    fontSize: 15,
    lineHeight: 20,
    color: COLOR.text2,
  },
  primary: {
    ...base,
    fontFamily: 'Outfit-Bold',
    fontSize: 18,
    lineHeight: 23,
    color: COLOR.white,
  },
};

/** 8 dp grid with 4 dp half-steps. */
export const SPACE = {
  half: 4,
  s1: 8,
  s2: 16,
  s3: 24,
  s4: 32,
  gutter: 24,
} as const;

export const RADIUS = {
  chip: 14,
  note: 7,
  sheet: 24,
  segment: 2,
} as const;

/** Android elevation plus the iOS shadow that reads the same. */
function elevation(
  android: number,
  ios: {opacity: number; radius: number; y: number},
  shadowColor: string = COLOR.ink,
): ViewStyle {
  return Platform.OS === 'android'
    ? {elevation: android, shadowColor}
    : {
        shadowColor,
        shadowOpacity: ios.opacity,
        shadowRadius: ios.radius,
        shadowOffset: {width: 0, height: ios.y},
      };
}

export const ELEVATION = {
  /** A neutral shadow under the near-black card (ink's is teal-tinted). */
  card: elevation(12, {opacity: 0.22, radius: 18, y: 12}, CARD.shadow),
  sheet: elevation(16, {opacity: 0.12, radius: 16, y: -4}),
  badge: elevation(6, {opacity: 0.16, radius: 8, y: 3}),
  hold: elevation(3, {opacity: 0.1, radius: 6, y: 2}),
  note: elevation(2, {opacity: 0.08, radius: 3, y: 1}),
} as const;

/** Durations (ms). */
export const DUR = {
  text: 120,
  state: 200,
  fill: 240,
  entry: 300,
  flood: 480,
  ambient: 2400,
  sheen: 1800,
  /** PIN pose ↔ running: the sheet clears, then card and ledger move as one. */
  dock: 360,
  finale: 1200,
  /**
   * From here on the finale's frame IS Success's first (flood complete,
   * badge on the Success centre). The flood is the 480 ms before it.
   */
  handoff: 1040,
  /**
   * The hand-off's reset goes out this long before that frame: mounting
   * Success takes longer than this on any device, so it lands on the final
   * frame (at worst a few ms early: < 0.2 dp of badge travel left).
   */
  handoffLead: 40,
  error: 480,
  burn: 620,
  roll: 640,
  fromIn: 640,
  lockOut: 360,
  split: 640,
  paid: 200,
  /** One straight INOUT rise into the card (0–440) plus the edge glow (→640). */
  slip: 640,
  /** CHANGE "4 ✓" — played only once a later phase confirms the write. */
  changeHome: 200,
  settleHelp: 240,
  /** Bottom action swap: out over the first half, in over the second. */
  actions: 200,
  settleHelpLead: 4000,
  ledgerIn: 400,
  success: 360,
  edgeTint: 180,
} as const;

/** Every motion curve on the screen. No springs anywhere. */
export const BEZIER = {
  OUT: [0.22, 1, 0.36, 1],
  INOUT: [0.65, 0, 0.35, 1],
  IN: [0.55, 0, 1, 0.45],
  STD: [0.2, 0, 0, 1],
} as const;
