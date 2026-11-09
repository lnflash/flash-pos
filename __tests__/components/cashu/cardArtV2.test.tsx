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
} from '../../../src/components/cashu/charge/cardArtV2';
import EcashCard, {
  cardIdStyle,
} from '../../../src/components/cashu/charge/EcashCard';
import {
  ART_H,
  ART_W,
  chargeLayout,
} from '../../../src/components/cashu/charge/geometry';
import {CARD, COLOR} from '../../../src/components/cashu/charge/tokens';
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
 *   flattened mark, outlined glyph and the z-order.
 * - RENDER_DIGESTS: the whole drawn tree, every element in order with every
 *   prop, under the svg stub (flash-mobile's stub uses the same host names).
 *   Static is flash-mobile's still card, chip-side arcs drawn in; animated is
 *   the charge card, which draws those arcs as its own overlays.
 */
const ART_FILE_SHA256 =
  '6e0b76e7542270cf9a45de8e7a642143b13cbd3d2e91a4573364392cba42b0d6';
const PARITY_DIGEST =
  'f7ce7004e269bd42be8fb11d7fea12bdc7e65e2e5a677a4cd85d3ebe93ba4ef1';
const RENDER_DIGESTS = {
  static: 'a607fbd4e4ae3fe5cb1ef9edb672253b97582ff32b8c07b59c2eef1d2043d164',
  animated: '5a2efcb2323249a3733be4fd60d550063a060e898463aa0f1e2b0a7d22b1126a',
};
/** The <Path>s each build draws: the static one adds the chip-side arcs. */
const RENDER_PATHS = {static: 6, animated: 5};

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
});

/** WCAG 2 contrast between two opaque hex colours. */
const contrast = (a: string, b: string) => {
  const lum = (hex: string) => {
    const [r, g, bl] = rgb(hex).map(c => {
      const x = c / 255;
      return x <= 0.04045 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4;
    });
    return 0.2126 * r + 0.7152 * g + 0.0722 * bl;
  };
  const [lo, hi] = [lum(a), lum(b)].sort((x, y) => x - y);
  return (hi + 0.05) / (lo + 0.05);
};

/** The x y pairs of a path of absolute M, L, C, Q and Z commands. */
const points = (d: string) => {
  const n = (d.match(/-?\d*\.?\d+/g) ?? []).map(Number);
  return n.flatMap((_, i) => (i % 2 ? [] : [[n[i], n[i + 1]]]));
};

describe('card art v2 — drawing rules', () => {
  it('is one <Svg> filling its parent: no nested Svg, Use, Mask, Text, Pattern, Image or filter', () => {
    const all = draw();
    const svgs = all.filter(n => n.type === 'RNSVGSvg');
    expect(svgs).toHaveLength(1);
    expect(svgs[0].props).toMatchObject({
      viewBox: '0 0 320 202',
      width: '100%',
      height: '100%',
      preserveAspectRatio: 'none',
    });
    // Nothing can fall back to another font or decode late, and nothing is
    // an offscreen layer that draws differently on Android and iOS.
    const allowed = new Set([
      'RNSVGSvg',
      'RNSVGDefs',
      'RNSVGClipPath',
      'RNSVGLinearGradient',
      'RNSVGStop',
      'RNSVGGroup',
      'RNSVGPath',
      'RNSVGRect',
    ]);
    all.forEach(n =>
      expect([n.type, allowed.has(String(n.type))]).toEqual([n.type, true]),
    );
    expect(all.filter(n => n.type === 'RNSVGPath')).toHaveLength(
      RENDER_PATHS.static,
    );
    expect(
      draw({staticArcs: false}).filter(n => n.type === 'RNSVGPath'),
    ).toHaveLength(RENDER_PATHS.animated);
  });

  it('puts every gradient in user space and opacity only on leaves', () => {
    const all = draw();
    const gradients = all.filter(n => /Gradient$/.test(String(n.type)));
    // The field and the chip's gold.
    expect(gradients.map(g => g.props.id).sort()).toEqual([
      'cardBase',
      'cardGold',
    ]);
    gradients.forEach(g =>
      expect(g.props.gradientUnits).toBe('userSpaceOnUse'),
    );
    all
      .filter(n => n.type === 'RNSVGGroup')
      .forEach(g => expect(g.props.opacity).toBeUndefined());
  });

  it('clips everything to the ISO 7810 corner: the field first, the edge hairline last', () => {
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
    const layers = face.children as Node[];
    expect(layers[0]).toMatchObject({
      type: 'RNSVGRect',
      props: {width: 320, height: 202, fill: 'url(#cardBase)'},
    });
    expect(layers[layers.length - 1]).toMatchObject({
      type: 'RNSVGRect',
      props: {fill: 'none', stroke: CARD_PALETTE.white, strokeOpacity: 0.02},
    });
  });

  it('draws the chip-side arcs in the art’s ink at the resting 60 % only in a static build', () => {
    const arcs = CARD_ART.chipArcs.d.join('');
    const find = (all: Node[]) =>
      all.find(n => n.type === 'RNSVGPath' && n.props.d === arcs);
    expect(find(draw())!.props).toMatchObject({
      stroke: CARD_PALETTE.ink,
      strokeOpacity: 0.6,
    });
    expect(find(draw({staticArcs: false}))).toBeUndefined();
  });

  it('keeps the z-order of the design: the field first, the caption and edge last', () => {
    expect(CARD_ART.layers).toEqual([
      'base',
      'mark',
      'lockup',
      'plate',
      'chipArcs',
      'caption',
      'edge',
    ]);
  });

  it('draws the mark, the lockup and the caption as outlined paths, never type', () => {
    const paths = draw().filter(n => n.type === 'RNSVGPath');
    const byD = (d: string) => paths.find(n => n.props.d === d)?.props;
    expect(byD(CARD_ART.mark.d)).toMatchObject({
      fill: CARD_PALETTE.markInk,
      fillOpacity: 57 / 255,
      fillRule: 'evenodd',
    });
    expect(byD(CARD_ART.lockup.cashu)).toMatchObject({
      fill: CARD_PALETTE.markInk,
    });
    expect(byD(CARD_ART.lockup.card)).toMatchObject({
      fill: CARD_PALETTE.inkSoft,
    });
    expect(byD(CARD_ART.caption.d)).toMatchObject({fill: CARD_PALETTE.ink});
  });

  it('keeps every small opacity on a whole 1/255 step, all Android keeps', () => {
    // react-native-svg rounds an opacity to 8 bits: a value between steps
    // would draw differently on Android and iOS.
    [CARD_ART.mark.opacity].forEach(opacity => {
      const steps = opacity * 255;
      expect(Math.abs(steps - Math.round(steps))).toBeLessThan(1e-9);
    });
  });

  it('lights the field and the chip plate light top-left to dark bottom-right, the plate with no outline', () => {
    const lum = (hex: string) => {
      const [r, g, b] = rgb(hex);
      return 0.299 * r + 0.587 * g + 0.114 * b;
    };
    [CARD_ART.base, CARD_ART.plate.gold].forEach(g => {
      expect(g.x2).toBeGreaterThan(g.x1);
      expect(g.y2).toBeGreaterThan(g.y1);
      const tones = g.stops.map(([, hex]) => lum(hex));
      tones.slice(1).forEach((tone, i) => expect(tone).toBeLessThan(tones[i]));
    });
    const plate = draw().find(
      n => n.type === 'RNSVGPath' && n.props.fill === 'url(#cardGold)',
    )!;
    expect(plate.props.d).toBe(CARD_ART.plate.d);
    expect(plate.props.stroke).toBeUndefined();
  });
});

describe('card art v2 — what the charge card reads from it', () => {
  it('keeps the plate, the chip-side arcs and an id slot', () => {
    expect(CARD_ART.plate).toMatchObject({
      x: 22.96,
      y: 70.29,
      w: 65.83,
      h: 49.71,
      rx: 8.85,
    });
    expect(CARD_ART.chipArcs.d).toHaveLength(3);
    expect(CARD_ART.chipArcs.width).toBe(1.97);
    expect(CARD_ART.chipArcs.box).toEqual({x: 99, y: 77, w: 17.5, h: 28.5});
    expect(CARD_ART.idSlot).toEqual({
      right: 297.4,
      centerY: 178.42,
      capRef: 6.46,
    });
  });

  it('holds each arc, caps included, inside the arcs’ box, right of the plate', () => {
    const {box, width} = CARD_ART.chipArcs;
    const cap = width / 2;
    CARD_ART.chipArcs.d.forEach(d => {
      // "Mx y0 Ar r 0 0 1 x y1": a symmetric arc bulging right.
      const [x, y0, r, , , , , , y1] = (d.match(/-?\d*\.?\d+/g) ?? []).map(
        Number,
      );
      const half = (y1 - y0) / 2;
      const apex = x + r - Math.sqrt(r * r - half * half);
      expect(x - cap).toBeGreaterThanOrEqual(box.x);
      expect(apex + cap).toBeLessThanOrEqual(box.x + box.w);
      expect(y0 - cap).toBeGreaterThanOrEqual(box.y);
      expect(y1 + cap).toBeLessThanOrEqual(box.y + box.h);
    });
    expect(box.x).toBeGreaterThan(CARD_ART.plate.x + CARD_ART.plate.w);
  });

  it('puts the id slot on the card, below the large mark and on the caption’s mid-line', () => {
    const {right, centerY, capRef} = CARD_ART.idSlot;
    expect(right).toBeLessThanOrEqual(CARD_ART.width - CARD_ART.radius);
    expect(centerY + capRef / 2).toBeLessThan(CARD_ART.height);
    const markBottom = Math.max(...points(CARD_ART.mark.d).map(([, y]) => y));
    expect(centerY - capRef / 2).toBeGreaterThan(markBottom);
    const captionYs = points(CARD_ART.caption.d).map(([, y]) => y);
    const mid = (Math.min(...captionYs) + Math.max(...captionYs)) / 2;
    expect(Math.abs(centerY - mid)).toBeLessThan(0.5);
  });
});

describe('card art v2 — palette', () => {
  it('has no Flash colours and no Flash bolt anywhere in the art', () => {
    const file = readFileSync(
      join(__dirname, '../../../src/components/cashu/charge/cardArtV2.tsx'),
      'utf8',
    ).toLowerCase();
    const rendered = draw().flatMap(n => colours(n.props));
    const all = [...colours(CARD_ART), ...rendered];
    expect(all.length).toBeGreaterThan(10);
    // Flash orange and the old near-black base.
    ['#f97316', '#080a0d'].forEach(hex => {
      expect(all).not.toContain(hex);
      expect(file).not.toContain(hex);
    });
    // The bolt's path, and every Flash-only layer.
    expect(file).not.toContain('m124.1,342.8');
    [
      'watermark',
      'lift',
      'grain',
      'slash',
      'rule',
      'halo',
      'ring',
      'contacts',
      'nfc',
      'btc',
      'flash',
      'bearer',
    ].forEach(layer =>
      expect(CARD_ART.layers as readonly string[]).not.toContain(layer),
    );
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
    expect(CARD.base).toBe('#9fc985');
    expect(CARD.dim).toBe('#000000');
  });

  it('prints the masked id in the mark’s ink at full opacity, legible on the greenDeep corner it sits on', () => {
    expect(CARD.id).toBe(CARD_PALETTE.markInk);
    // The slot is the field's dark end; the caption's ink at 60 % blended
    // there to 1.94:1. The id is the only on-screen sign of which card was
    // tapped, so it takes the darkest card ink.
    expect(contrast(CARD.id, CARD_PALETTE.greenDeep)).toBeGreaterThan(4);
    expect(contrast(CARD.id, CARD_PALETTE.green)).toBeGreaterThan(4);
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

  it('ends the masked id on the id slot’s right edge, centred on the caption’s mid-line', () => {
    const {getByTestId, getByText} = render(
      <EcashCard layout={L} n={n} last4="0C67" />,
    );
    expect(getByText('•••• 0C67')).toBeTruthy();
    const row = StyleSheet.flatten(getByTestId('card-id-row').props.style);
    expect(row.right).toBeCloseTo((320 - CARD_ART.idSlot.right) * k, 6);
    expect(row.right).toBeCloseTo((320 - 297.4) * k, 6);
    expect(row.top + row.height / 2).toBeCloseTo(
      CARD_ART.idSlot.centerY * k,
      6,
    );
    expect(row.top + row.height / 2).toBeCloseTo(178.42 * k, 6);
    // Inside the card at the bottom.
    expect(row.top + row.height).toBeLessThanOrEqual(L.card.h);
    // Clear of the hold pill (top 15 dp) and the corner badge (20 dp).
    expect(row.top).toBeGreaterThan(15);
  });

  it('sizes the masked id with the card, never with the font scale, at a cap ~1.35x the caption’s', () => {
    const {getByTestId} = render(<EcashCard layout={L} n={n} last4="0C67" />);
    const id = getByTestId('card-id');
    const style = StyleSheet.flatten(id.props.style);
    expect(style.fontSize).toBeCloseTo(12 * k, 6);
    expect(style.lineHeight).toBeCloseTo(16 * k, 6);
    expect(style.letterSpacing).toBeCloseTo(1.5 * k, 6);
    expect(style).toEqual(cardIdStyle(k));
    // A large system font never enlarges it.
    expect(id.props.maxFontSizeMultiplier).toBe(1);
    // Outfit's digit cap (~0.725 em) against the caption's cap
    // (idSlot.capRef): the same ratio at every k, pinned at 1.35. The id is
    // larger than CASHU ECASH CARD, not quieter: the art's capRef contract
    // (cardArtV2.tsx idSlot) would need 8.5 dp or less at k = 1, the owner's
    // call from the device pass. Any growth past 1.35 fails here.
    const ratio = (0.725 * style.fontSize) / (CARD_ART.idSlot.capRef * k);
    expect(ratio).toBeCloseTo((0.725 * 12) / 6.46, 6);
    expect(ratio).toBeCloseTo(1.35, 2);
    expect(style.color).toBe(CARD.id);
    // Its row holds the line at this size, centred on the caption.
    const row = StyleSheet.flatten(getByTestId('card-id-row').props.style);
    expect(row.height).toBeCloseTo(28 * k, 6);
    expect(row.height).toBeGreaterThan(style.lineHeight);
  });

  it('runs the change glow across the card’s whole width, from x 0', () => {
    const {getByTestId} = render(<EcashCard layout={L} n={n} last4={null} />);
    const glow = StyleSheet.flatten(getByTestId('card-glow').props.style);
    expect(glow.left).toBe(0);
    expect(glow.width).toBeCloseTo(L.card.w, 6);
    expect(glow.bottom).toBe(0);
  });

  it('draws the change glow in white over an ink rule, never in a green the field swallows', () => {
    const {getByTestId} = render(<EcashCard layout={L} n={n} last4={null} />);
    const glow = getByTestId('card-glow');
    const [gradient] = glow.findAll(
      node =>
        String(node.type) === 'RNSVGLinearGradient' && node.props.id === 'glow',
    );
    const stops = gradient
      .findAll(node => String(node.type) === 'RNSVGStop')
      .map(node => [node.props.stopColor, node.props.stopOpacity]);
    expect(stops).toEqual([
      ['#ffffff', 0],
      ['#ffffff', 0.35],
    ]);
    const [group] = glow.findAll(node => String(node.type) === 'RNSVGGroup');
    const rects = group
      .findAll(node => String(node.type) === 'RNSVGRect')
      .map(node => [node.props.y, node.props.height, node.props.fill]);
    expect(rects).toEqual([
      ['0', '11', 'url(#glow)'],
      ['11', '1', CARD.ink],
      ['12', '2', '#ffffff'],
    ]);
    // Neither colour is the field's: the ink rule holds 3:1 against every
    // stop of the face, and the white rule 12:1 against the ink under it.
    CARD_ART.base.stops.forEach(([, colour]) =>
      expect(contrast(CARD.ink, colour)).toBeGreaterThan(3),
    );
    expect(contrast('#ffffff', CARD.ink)).toBeGreaterThan(11);
    const painted = glow
      .findAll(node => ['RNSVGStop', 'RNSVGRect'].includes(String(node.type)))
      .map(node => String(node.props.stopColor ?? node.props.fill));
    expect(painted).not.toContain(COLOR.green);
  });

  it('draws each animated arc through the art’s own arc box, peaking so the rest reads 60 %', () => {
    const {getByTestId} = render(<EcashCard layout={L} n={n} last4={null} />);
    [0, 1, 2].forEach(i => {
      const box = StyleSheet.flatten(getByTestId(`card-arc-${i}`).props.style);
      expect(box.left).toBeCloseTo(99 * k, 6);
      expect(box.top).toBeCloseTo(77 * k, 6);
      expect(box.width).toBeCloseTo(17.5 * k, 6);
      expect(box.height).toBeCloseTo(28.5 * k, 6);
    });
  });

  it('strokes each animated arc in the art’s ink, at the peak that rests at 60 %', () => {
    const {UNSAFE_root} = render(<EcashCard layout={L} n={n} last4={null} />);
    const strokes = UNSAFE_root.findAll(
      node =>
        String(node.type) === 'RNSVGPath' &&
        CARD_ART.chipArcs.d.includes(node.props.d),
    );
    expect(strokes).toHaveLength(3);
    strokes.forEach(p =>
      expect(p.props).toMatchObject({
        stroke: CARD.ink,
        strokeWidth: CARD_ART.chipArcs.width,
      }),
    );
  });
});
