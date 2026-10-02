import {
  ACTION_H,
  CHIP_NUMBER_H,
  CHIP_NUMBER_TOP,
  FINALE_BADGE,
  HEADER_H,
  LEDGER_H,
  NOTE_H,
  PILL_H,
  PIN_SCALE,
  TITLE_H,
  chargeLayout,
} from '../../../src/components/cashu/charge/geometry';
import {successBadgeCenter} from '../../../src/utils/successBadge';

/** The test phone: 395 x 880 dp window, 44 status + 24 gesture insets. */
const WINDOW_H = 880;
const TOP_INSET = 44;
const FRAME = {width: 395, height: 812};
const PR = 3.4;
const L = chargeLayout(FRAME, {pixelRatio: PR});
const onGrid = (v: number) => Math.abs(v * PR - Math.round(v * PR)) < 1e-6;
/** Within one device pixel: what snapping each edge can cost. */
const expectPx = (a: number, b: number) =>
  expect(Math.abs(a - b)).toBeLessThanOrEqual(1 / PR + 1e-9);

describe('chargeLayout on the test phone (395 x 812 frame)', () => {
  it('sizes the card at ID-1 and centres it', () => {
    expect(L.tier).toBe('regular');
    expect(L.card.w).toBeCloseTo(315, 0);
    expect(L.card.x).toBeCloseTo(40, 0);
    expect(L.card.w / L.card.h).toBeCloseTo(1.584, 2);
    expect(L.card.x + L.card.w / 2).toBeCloseTo(FRAME.width / 2, 0);
    // 76-82 % of the window width.
    expect(L.card.w / FRAME.width).toBeGreaterThanOrEqual(0.76);
    expect(L.card.w / FRAME.width).toBeLessThanOrEqual(0.82);
  });

  it('puts the group where the design pack measured it (40 dp lane, +8 bias)', () => {
    expect(L.amountTop).toBeCloseTo(153.6, 0);
    expect(L.card.y).toBeCloseTo(249.6, 0);
    expect(L.card.cy).toBeCloseTo(349.0, 0);
    expect(L.ledgerTop).toBeCloseTo(488.4, 0);
    expect(L.stepperTop).toBeCloseTo(572.4, 0);
    expect(L.titleTop).toBeCloseTo(596.4, 0);
    expect(L.pillTop).toBeCloseTo(630.4, 0);
  });

  it('centres the group between the header and the action within 24 dp', () => {
    const groupTop = L.amountTop;
    const groupBottom = L.pillTop + PILL_H;
    const band = (HEADER_H + L.actionTop) / 2;
    expect(Math.abs((groupTop + groupBottom) / 2 - band)).toBeLessThanOrEqual(
      24,
    );
  });

  it('keeps the top 18 % of the window for the header only', () => {
    expect(L.amountTop + TOP_INSET).toBeGreaterThanOrEqual(0.18 * WINDOW_H);
  });

  it('leaves no empty band taller than 15 % of the window', () => {
    const limit = 0.15 * WINDOW_H;
    expect(L.bands.top).toBeLessThanOrEqual(limit);
    expect(L.bands.bottom).toBeLessThanOrEqual(limit);
    // W0: the verbatim pill is still hidden, so the gap runs from the title
    // to the visible Cancel (text ~14 dp into its 48 dp hit box). Measured
    // glyph to glyph on the device, so keep a margin under the limit.
    const cancelTextTop = L.cancelTop + (48 - 20) / 2;
    expect(cancelTextTop - (L.titleTop + TITLE_H)).toBeLessThanOrEqual(
      limit - 16,
    );
    // ...clear of the two-line helper slot, never below the action slot.
    expect(L.cancelTop).toBeGreaterThanOrEqual(L.helperTop + 40);
    expect(L.cancelTop).toBeLessThanOrEqual(L.actionTop + 4);
    // Tap flow, running, before the plan: the unsegmented track fills the
    // ledger's slot, so the band runs from the card to the track.
    expect(L.stepperTop - (L.card.y + L.card.h)).toBeLessThanOrEqual(limit);
  });

  it('prints the ledger and the stepper edge to edge with the card', () => {
    for (const shape of [L.three, L.two]) {
      const first = shape.chips[0];
      const last = shape.chips[shape.chips.length - 1];
      expect(first.x).toBeCloseTo(L.card.x, 1);
      expect(last.x + last.w).toBeCloseTo(L.card.x + L.card.w, 1);
    }
    // FROM under the card's left third, CHANGE under its right third.
    const third = L.card.w / 3;
    expect(L.three.chips[0].cx).toBeLessThan(L.card.x + third);
    expect(L.three.chips[2].cx).toBeGreaterThan(L.card.x + 2 * third);
    expectPx(L.three.chips[0].w, (L.card.w - 40) / 3);
    expectPx(L.two.chips[0].w, (L.card.w - 20) / 2);
  });

  it('parks the notes fully behind the card and lands them on the number line', () => {
    expect(L.note.parkTop).toBeGreaterThanOrEqual(L.card.y);
    expect(L.note.parkTop + NOTE_H).toBeLessThanOrEqual(L.card.y + L.card.h);
    expectPx(L.numberCy, L.ledgerTop + CHIP_NUMBER_TOP + CHIP_NUMBER_H / 2);
    expectPx(L.note.landTop + NOTE_H / 2, L.numberCy);
    expect(L.note.drop).toBeCloseTo(75, 0);
  });

  it('straddles the card top edge with the hold pill', () => {
    expect(L.holdTop + 15).toBeCloseTo(L.card.y, 1);
  });

  it('lands the finale badge exactly where Success draws its badge', () => {
    const success = successBadgeCenter(FRAME, PR);
    expect(L.finale.cx).toBeCloseTo(success.x, 1);
    expect(Math.abs(L.finale.cy + L.finale.dy - success.y)).toBeLessThanOrEqual(
      1,
    );
    expect(L.finale.dy).toBeCloseTo(-72.9, 0);
  });

  it('grows the flood past the farthest corner', () => {
    const radius = (L.finale.floodEnd * FINALE_BADGE) / 2;
    const corners = [
      [0, 0],
      [FRAME.width, 0],
      [0, FRAME.height],
      [FRAME.width, FRAME.height],
    ];
    corners.forEach(([x, y]) => {
      expect(Math.hypot(x - L.finale.cx, y - L.finale.cy)).toBeLessThan(radius);
    });
    expect(L.finale.floodEnd).toBeCloseTo(12.63, 1);
  });

  it('docks the PIN pose: small card 20 dp under the amount, ledger clear of the sheet', () => {
    const smallTop = L.card.cy + L.pin.cardDy - (L.card.h * PIN_SCALE) / 2;
    expect(smallTop - (L.amountTop + 60)).toBeCloseTo(20, 0);
    expect(L.pin.cardDy).toBeCloseTo(-71.65, 0);
    expect(L.pin.ledgerDy).toBeCloseTo(-151.3, 0);
    expect(L.pin.ledgerVisible).toBe(true);
    expect(L.ledgerTop + L.pin.ledgerDy + LEDGER_H).toBeLessThanOrEqual(
      L.pin.sheetTop - 8,
    );
    expect(L.pin.sheetH).toBe(400);
    expect(L.pin.rowHeight).toBe(64);
  });

  it('snaps every coordinate to the device pixel grid', () => {
    [
      L.card.x,
      L.card.y,
      L.amountTop,
      L.ledgerTop,
      L.stepperTop,
      L.titleTop,
      L.pillTop,
      L.helperTop,
      L.holdTop,
      L.note.parkTop,
      L.note.landTop,
      L.finale.dy,
      L.pin.cardDy,
      L.pin.ledgerDy,
      ...L.three.chips.map(c => c.x),
      ...L.three.ops,
    ].forEach(v => expect(onGrid(v)).toBe(true));
  });

  it('keeps the action slot 24 dp above the bottom', () => {
    expect(L.actionTop + ACTION_H + 24).toBeCloseTo(FRAME.height, 0);
  });
});

describe('chargeLayout on smaller phones', () => {
  it('drops to compact gaps first, keeping the card size', () => {
    const compact = chargeLayout({width: 360, height: 720}, {pixelRatio: 3});
    expect(compact.tier).toBe('compact');
    expect(compact.gaps).toMatchObject({a: 24, c: 16, d: 12, e: 8});
    expect(compact.card.w).toBeCloseTo(280, 1);
    expect(compact.bands.bottom).toBeGreaterThanOrEqual(59.5);
  });

  it('then shrinks the card to fit, never below 240', () => {
    const tight = chargeLayout({width: 395, height: 700}, {pixelRatio: 3});
    expect(tight.tier).toBe('tight');
    expect(tight.card.w).toBeLessThan(315);
    expect(tight.card.w).toBeGreaterThan(240);
    expect(tight.bands.bottom).toBeGreaterThanOrEqual(59.5);
    expect(tight.card.x + tight.card.w / 2).toBeCloseTo(197.5, 0);
    const tiniest = chargeLayout({width: 320, height: 520}, {pixelRatio: 2});
    expect(tiniest.card.w).toBe(240);
  });

  it('narrows caption tracking and operator gaps for tiny chips', () => {
    const tiny = chargeLayout({width: 320, height: 760}, {pixelRatio: 2});
    expect((tiny.card.w - 40) / 3).toBeLessThan(84);
    expect(tiny.captionTracking).toBe(0.2);
    const gap =
      tiny.three.chips[1].x - (tiny.three.chips[0].x + tiny.three.chips[0].w);
    expect(gap).toBeCloseTo(14, 0);
  });
});
