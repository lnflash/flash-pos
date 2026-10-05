import {createHash} from 'crypto';
import {readFileSync} from 'fs';
import {join} from 'path';
import React from 'react';
import {Animated, StyleSheet} from 'react-native';
import {render} from '@testing-library/react-native';
import type {ReactTestRendererJSON} from 'react-test-renderer';

jest.mock('react-native-svg', () => require('../../../__mocks__/svgStub'));

import {
  CARD_ART,
  CARD_PALETTE,
  CardArtV2,
  grainTile,
} from '../../../src/components/cashu/charge/cardArtV2';
import EcashCard, {
  cardIdStyle,
} from '../../../src/components/cashu/charge/EcashCard';
import {
  ART_H,
  ART_W,
  chargeLayout,
} from '../../../src/components/cashu/charge/geometry';
import {CARD} from '../../../src/components/cashu/charge/tokens';
import type {Nodes} from '../../../src/components/cashu/charge/useChargeEngine';

/**
 * cardArtV2.tsx is shared byte-for-byte with flash-mobile
 * (app/components/flashcard-v2-art/cardArtV2.tsx). Neither repo's tests read
 * the other's file: each pins its own copy to the same digests, so an edit to
 * either copy fails that repo's suite until its digests are bumped, which is
 * the cue to copy the file across and bump the other's. Change both copies
 * and all their digests together.
 *
 * - ART_FILE_SHA256: the file itself, with LF line endings: comments, types
 *   and formatting included, which the other digests do not see.
 * - PARITY_DIGEST: CARD_ART — every coordinate, colour, opacity, gradient,
 *   outlined glyph, the grain and the z-order.
 * - RENDER_DIGESTS: the whole drawn tree, every element in order with every
 *   prop, under the svg stub (flash-mobile's stub uses the same host names).
 *   Static is flash-mobile's still card, chip-side arcs drawn in; animated is
 *   the charge card, which draws those arcs as its own overlays.
 */
const ART_FILE_SHA256 =
  '355472b69813ca55b2965c50a31dc11430d0c92dfc3dfd896816edb45d901927';
const PARITY_DIGEST =
  '88c4f9c1ca91a921cab0d09362c42d12647a155d0a6c847f5a935283cbd77e02';
const RENDER_DIGESTS = {
  static: '9bab0b61f17e0580e5cebcb21a8d730792a2e20f91de9b13f2229a71d294d88c',
  animated: '270a9876f3e6b61e7b5c70c5e3b5e4d8dbdea7e167786bf7adb1f91f734e6a7d',
};

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

type Node = ReactTestRendererJSON;

function nodes(root: Node | Node[] | null): Node[] {
  const out: Node[] = [];
  const visit = (n: Node | string) => {
    if (typeof n === 'string') {
      return;
    }
    out.push(n);
    (n.children ?? []).forEach(visit);
  };
  (Array.isArray(root) ? root : root ? [root] : []).forEach(visit);
  return out;
}

const tree = (props: {staticArcs?: boolean} = {}) =>
  render(<CardArtV2 {...props} />).toJSON() as Node;

const draw = (props: {staticArcs?: boolean} = {}) => nodes(tree(props));

/** Each element as [type, props sorted by name, children]: what both repos hash. */
const canonical = (n: Node | string): unknown =>
  typeof n === 'string'
    ? n
    : [
        n.type,
        Object.keys(n.props)
          .sort()
          .map(key => [key, n.props[key]]),
        (n.children ?? []).map(canonical),
      ];

/** Every #rrggbb string in a value, recursively. */
function colours(value: unknown, out: string[] = []): string[] {
  if (typeof value === 'string') {
    if (/^#[0-9a-f]{6}$/i.test(value)) {
      out.push(value.toLowerCase());
    }
  } else if (Array.isArray(value)) {
    value.forEach(v => colours(v, out));
  } else if (value && typeof value === 'object') {
    Object.values(value).forEach(v => colours(v, out));
  }
  return out;
}

const rgb = (hex: string) =>
  [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16));

describe('card art v2 — parity with flash-mobile', () => {
  it('pins the file’s bytes, comments and formatting included', () => {
    const file = readFileSync(
      join(__dirname, '../../../src/components/cashu/charge/cardArtV2.tsx'),
      'utf8',
    );
    // A Windows checkout may hand the file over with CRLF line endings.
    expect(sha256(file.replace(/\r\n/g, '\n'))).toBe(ART_FILE_SHA256);
  });

  it('pins the art’s values (CARD_ART)', () => {
    expect(sha256(JSON.stringify(CARD_ART))).toBe(PARITY_DIGEST);
  });

  it('pins the drawn tree, element for element', () => {
    expect(sha256(JSON.stringify(canonical(tree())))).toBe(
      RENDER_DIGESTS.static,
    );
    expect(sha256(JSON.stringify(canonical(tree({staticArcs: false}))))).toBe(
      RENDER_DIGESTS.animated,
    );
  });

  it('builds the grain exactly as the reference generator does (balanced Latin square, mulberry32, seed 0x0C67F1A5)', () => {
    const [light, dark] = grainTile(0x0c67f1a5, 32, 40, 285);
    expect(light).toBe(CARD_ART.grain.light.d);
    expect(dark).toBe(CARD_ART.grain.dark.d);
    // The reference generator's output (build_preview.py), byte for byte.
    expect(sha256(light)).toBe(
      '24d9fc352deeaae932750e42854937c3294b895bba54ea6d1cfcd191399408a0',
    );
    expect(sha256(dark)).toBe(
      'afe57feec43a12a3dafeab90cb89f1059ce8958fadc4e6aa4c318a061c182ada',
    );
  });

  it('lays 285 light and 285 dark specks on distinct cells of one 32-unit tile', () => {
    const cells = (d: string) =>
      [...d.matchAll(/M([\d.]+) ([\d.]+)h0\.8v0\.8h-0\.8z/g)].map(m => [
        Number(m[1]),
        Number(m[2]),
      ]);
    const light = cells(CARD_ART.grain.light.d);
    const dark = cells(CARD_ART.grain.dark.d);
    expect(light).toHaveLength(285);
    expect(dark).toHaveLength(285);
    const keys = new Set([...light, ...dark].map(([x, y]) => `${x},${y}`));
    expect(keys.size).toBe(570);
    [...light, ...dark].forEach(([x, y]) => {
      expect(x).toBeGreaterThanOrEqual(0);
      expect(x).toBeLessThanOrEqual(31.2);
      expect(y).toBeGreaterThanOrEqual(0);
      expect(y).toBeLessThanOrEqual(31.2);
    });
  });

  it('balances every row and column of the tile: 7 or 8 specks of each tone, never a line', () => {
    // A plain shuffle put 15 dark specks and 1 light one in a row: a dark
    // line ~1.5 levels deep, repeated every 32 units down the card. The
    // mean is 285 / 40 = 7.1 per row and column, for each tone.
    const count = (d: string, axis: 1 | 2) => {
      const out = new Array(40).fill(0);
      [...d.matchAll(/M([\d.]+) ([\d.]+)h/g)].forEach(m => {
        out[Math.round(Number(m[axis]) / 0.8)] += 1;
      });
      return out;
    };
    [CARD_ART.grain.light.d, CARD_ART.grain.dark.d].forEach(d => {
      [count(d, 1), count(d, 2)].forEach(lines => {
        expect(lines.reduce((a, b) => a + b, 0)).toBe(285);
        expect(Math.min(...lines)).toBeGreaterThanOrEqual(7);
        expect(Math.max(...lines)).toBeLessThanOrEqual(8);
      });
    });
    // Any tile size keeps the property (the spares spread over rows).
    const [light] = grainTile(7, 32, 40, 300);
    const rows = count(light, 2);
    expect(Math.max(...rows) - Math.min(...rows)).toBeLessThanOrEqual(1);
  });
});

describe('card art v2 — drawing rules', () => {
  it('is one <Svg> filling its parent: no nested Svg, Text, Pattern, Image or filter', () => {
    const all = draw();
    const svgs = all.filter(n => n.type === 'RNSVGSvg');
    expect(svgs).toHaveLength(1);
    expect(svgs[0].props).toMatchObject({
      viewBox: '0 0 320 202',
      width: '100%',
      height: '100%',
      preserveAspectRatio: 'none',
    });
    const allowed = new Set([
      'RNSVGSvg',
      'RNSVGDefs',
      'RNSVGClipPath',
      'RNSVGLinearGradient',
      'RNSVGRadialGradient',
      'RNSVGStop',
      'RNSVGGroup',
      'RNSVGPath',
      'RNSVGRect',
      'RNSVGCircle',
      'RNSVGUse',
    ]);
    all.forEach(n => expect(allowed.has(String(n.type))).toBe(true));
  });

  it('puts every gradient in user space and opacity only on leaves', () => {
    const all = draw();
    const gradients = all.filter(n => /Gradient$/.test(String(n.type)));
    // The lift, the slash, the chip's halo and its gold.
    expect(gradients).toHaveLength(4);
    gradients.forEach(g =>
      expect(g.props.gradientUnits).toBe('userSpaceOnUse'),
    );
    all
      .filter(n => n.type === 'RNSVGGroup')
      .forEach(g => expect(g.props.opacity).toBeUndefined());
  });

  it('clips everything to the ISO 7810 corner and instances the grain 70 times', () => {
    const all = draw();
    const clip = all.find(n => n.type === 'RNSVGClipPath')!;
    expect(clip.props.id).toBe('cardClip');
    expect((clip.children![0] as Node).props).toMatchObject({
      width: 320,
      height: 202,
      rx: 11.9,
      ry: 11.9,
    });
    const face = all.find(
      n => n.type === 'RNSVGGroup' && n.props.clipPath === 'url(#cardClip)',
    )!;
    expect(face).toBeTruthy();
    const uses = all.filter(n => n.type === 'RNSVGUse');
    expect(uses).toHaveLength(70);
    uses.forEach(u => expect(u.props.href).toBe('#cardGrain'));
    expect(Math.max(...uses.map(u => u.props.x))).toBe(288);
    expect(Math.max(...uses.map(u => u.props.y))).toBe(192);
  });

  it('draws the chip-side arcs at the resting 60 % only in a static build', () => {
    const arcs = CARD_ART.chipArcs.d.join('');
    const find = (all: Node[]) =>
      all.find(n => n.type === 'RNSVGPath' && n.props.d === arcs);
    expect(find(draw())!.props.strokeOpacity).toBe(0.6);
    expect(find(draw({staticArcs: false}))).toBeUndefined();
  });

  it('keeps the z-order of the design: base first, the lockup and edge last', () => {
    expect(CARD_ART.layers).toEqual([
      'base',
      'lift',
      'watermark',
      'grain',
      'slash',
      'rule',
      'halo',
      'ring',
      'plate',
      'contacts',
      'chipArcs',
      'nfc',
      'btc',
      'flash',
      'bearer',
      'edge',
    ]);
  });

  it('splits the left rule where the slash meets the edge: full above, lighter over the slash', () => {
    const orange = draw().filter(
      n =>
        n.type === 'RNSVGRect' &&
        n.props.fill === CARD_PALETTE.orange &&
        n.props.x === 0,
    );
    expect(orange.map(n => n.props)).toEqual([
      expect.objectContaining({
        y: 0,
        width: 1.8,
        height: 157,
        fillOpacity: 0.5,
      }),
      expect.objectContaining({
        y: 157,
        width: 1.8,
        height: 45,
        fillOpacity: 0.25,
      }),
    ]);
    // The split is the slash's own left-edge point.
    expect(CARD_ART.slash.d).toBe(
      `M0 ${CARD_ART.rule.split} L112.9 202 L0 202 Z`,
    );
  });

  it('lights the face with a cool lift, never a warm or neutral one', () => {
    const lift = draw().find(
      n => n.type === 'RNSVGRadialGradient' && n.props.id === 'cardLift',
    )!;
    const [r, g, b] = rgb(CARD_PALETTE.lift);
    expect(b).toBeGreaterThan(r);
    expect(b).toBeGreaterThan(g);
    (lift.children as Node[]).forEach(stop =>
      expect(stop.props.stopColor).toBe(CARD_PALETTE.lift),
    );
    // The plateau over the base lands on the sheet's blue-black: blue well
    // above green, and red no further below green than the base has it.
    const [br, bg, bb] = rgb(CARD_PALETTE.base);
    const top = CARD_ART.lift.stops[0][1];
    const core = [r, g, b].map((c, i) => [br, bg, bb][i] * (1 - top) + c * top);
    expect(core[2] - core[1]).toBeGreaterThan(4);
    expect(core[1] - core[0]).toBeLessThan(bg - br);
  });

  it('keeps every lift opacity on a whole 1/255 step, all Android keeps of a stop', () => {
    // react-native-svg rounds a stop's opacity to 8 bits: a value between
    // steps would draw differently on Android and iOS.
    CARD_ART.lift.stops.forEach(([, opacity]) => {
      const steps = opacity * 255;
      expect(Math.abs(steps - Math.round(steps))).toBeLessThan(1e-9);
    });
  });

  it('lights the chip plate as on the sheet: a deep top-left corner, a light middle, a darker bottom-right, no outline', () => {
    const lum = (hex: string) => {
      const [r, g, b] = rgb(hex);
      return 0.299 * r + 0.587 * g + 0.114 * b;
    };
    const gold = CARD_ART.plate.gold.stops.map(([, hex]) => lum(hex));
    const middle = Math.max(...gold);
    expect(gold[0]).toBeLessThan(middle - 30);
    expect(gold[gold.length - 1]).toBeLessThan(middle - 10);
    expect(gold[0]).toBeLessThan(gold[gold.length - 1]);
    // The light runs from the top-left corner to the bottom-right one.
    const {x1, y1, x2, y2} = CARD_ART.plate.gold;
    expect(x2).toBeGreaterThan(x1);
    expect(y2).toBeGreaterThan(y1);
    const plate = draw().find(
      n => n.type === 'RNSVGRect' && n.props.fill === 'url(#cardGold)',
    )!;
    expect(plate.props.stroke).toBeUndefined();
  });

  it('runs exactly 42 dash periods round the chip ring, so there is no seam', () => {
    const {w, h, rx, dash} = CARD_ART.ring;
    const perimeter = 2 * (w + h) - 8 * rx + 2 * Math.PI * rx;
    const periods = perimeter / (dash[0] + dash[1]);
    expect(Math.abs(periods - 42)).toBeLessThan(0.01);
  });
});

describe('card art v2 — palette', () => {
  it('has no green anywhere in the art (Flash green is the app’s)', () => {
    const rendered = draw().flatMap(n => colours(n.props));
    const all = [...colours(CARD_ART), ...rendered];
    expect(all.length).toBeGreaterThan(20);
    all.forEach(hex => {
      const [r, g, b] = rgb(hex);
      expect([hex, g > r && g > b]).toEqual([hex, false]);
    });
  });

  it('is the palette the charge screen’s CARD tokens mirror', () => {
    (Object.keys(CARD_PALETTE) as Array<keyof typeof CARD_PALETTE>)
      .filter(key => key !== 'white' && key !== 'black')
      .forEach(key =>
        expect([key, CARD[key as keyof typeof CARD]]).toEqual([
          key,
          CARD_PALETTE[key],
        ]),
      );
    expect(CARD.base).toBe('#080a0d');
    expect(CARD.dim).toBe('#000000');
  });

  it('is the artboard the charge geometry sizes the card from', () => {
    expect([ART_W, ART_H]).toEqual([CARD_ART.width, CARD_ART.height]);
    expect(CARD_ART.viewBox).toBe(`0 0 ${ART_W} ${ART_H}`);
  });
});

describe.each([
  ['a 395 dp phone (k ≈ 0.98)', 395],
  ['a 320 dp phone (k = 0.75)', 320],
])('EcashCard — the overlays on the shared art, %s', (_, width) => {
  const L = chargeLayout({width, height: 830}, {pixelRatio: 3.4});
  const k = L.card.k;
  const v = () => new Animated.Value(1);
  const n = {
    translateX: v(),
    translateY: v(),
    scale: v(),
    opacity: v(),
    arcs: [v(), v(), v()],
    sheenX: v(),
    sheenOpacity: v(),
    dim: v(),
    glow: v(),
    last4: v(),
  } as unknown as Nodes['card'];

  it('ends the masked id on FLASH’s right edge, centred on the chip', () => {
    const {getByTestId, getByText} = render(
      <EcashCard layout={L} n={n} last4="0C67" />,
    );
    expect(getByText('•••• 0C67')).toBeTruthy();
    const row = StyleSheet.flatten(getByTestId('card-id-row').props.style);
    expect(row.right).toBeCloseTo((320 - 298.9) * k, 6);
    expect(row.top + row.height / 2).toBeCloseTo(49.6 * k, 6);
    // Clear of the hold pill (top 15 dp) and the corner badge (20 dp).
    expect(row.top).toBeGreaterThan(15);
  });

  it('sizes the masked id with the card, never with the font scale, so it stays quieter than FLASH', () => {
    const {getByTestId} = render(<EcashCard layout={L} n={n} last4="0C67" />);
    const id = getByTestId('card-id');
    const style = StyleSheet.flatten(id.props.style);
    expect(style.fontSize).toBeCloseTo(12 * k, 6);
    expect(style.lineHeight).toBeCloseTo(16 * k, 6);
    expect(style.letterSpacing).toBeCloseTo(1.5 * k, 6);
    expect(style).toEqual(cardIdStyle(k));
    // A large system font never enlarges it.
    expect(id.props.maxFontSizeMultiplier).toBe(1);
    // Outfit's digit cap (~0.725 em) against FLASH's 11.35-unit cap: the
    // same ratio at every k, well under FLASH.
    expect((0.725 * style.fontSize) / (11.35 * k)).toBeLessThan(0.8);
    // Its row holds the line at this size, centred on the chip.
    const row = StyleSheet.flatten(getByTestId('card-id-row').props.style);
    expect(row.height).toBeCloseTo(28 * k, 6);
    expect(row.height).toBeGreaterThan(style.lineHeight);
  });

  it('starts the change glow at the slash’s tip, so the app green never crosses the orange', () => {
    const {getByTestId} = render(<EcashCard layout={L} n={n} last4={null} />);
    const glow = StyleSheet.flatten(getByTestId('card-glow').props.style);
    expect(glow.left).toBeCloseTo(CARD_ART.slash.tipX * k, 6);
    expect(glow.left + glow.width).toBeCloseTo(L.card.w, 6);
    expect(glow.bottom).toBe(0);
  });

  it('draws each animated arc through the art’s own arc box, peaking so the rest reads 60 %', () => {
    const {getByTestId} = render(<EcashCard layout={L} n={n} last4={null} />);
    [0, 1, 2].forEach(i => {
      const box = StyleSheet.flatten(getByTestId(`card-arc-${i}`).props.style);
      expect(box.left).toBeCloseTo(75 * k, 6);
      expect(box.top).toBeCloseTo(38 * k, 6);
      expect(box.width).toBeCloseTo(16 * k, 6);
      expect(box.height).toBeCloseTo(18 * k, 6);
    });
  });
});
