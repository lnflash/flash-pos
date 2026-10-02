import {Animated} from 'react-native';

import {
  CHIP_CAPTION_TOP,
  FINALE_REST_SCALE,
  NOTE_H,
  NOTE_W,
  chargeLayout,
} from '../../../src/components/cashu/charge/geometry';
import {
  INITIAL_STAGE,
  mapPhase,
  type StageState,
} from '../../../src/components/cashu/charge/phaseToStation';
import {DUR} from '../../../src/components/cashu/charge/tokens';
import {
  Conductor,
  GHOST_A,
  GHOST_B,
  HOLD_MAX_W,
  NOTE_CUT,
  NOTE_LAND,
  SLIP_HIDDEN,
  SPLIT_ROLL,
  SlotRing,
  buildNodes,
  createValues,
  slot,
  type Num,
  type PlanShape,
  type Snapshot,
} from '../../../src/components/cashu/charge/useChargeEngine';

/**
 * The choreography, checked numerically on the real node graph: each clock
 * is set by hand and every animated property is read back through the same
 * interpolation tables the native driver runs.
 */

const L = chargeLayout({width: 395, height: 812}, {pixelRatio: 3.4});
const at = (node: Num) =>
  (node as unknown as {__getValue: () => number}).__getValue();
const range = (from: number, to: number, step = 2) =>
  Array.from(
    {length: Math.floor((to - from) / step) + 1},
    (_, i) => from + i * step,
  );

function graph(three = true) {
  const v = createValues({mode: 'running', pose: 'run', planKnown: true});
  const n = buildNodes(v, L, false);
  const spots = three ? L.three : L.two;
  v.dxA.setValue(spots.chips[1].cx - spots.chips[0].cx);
  v.dxB.setValue(three ? L.three.chips[2].cx - L.three.chips[0].cx : 0);
  return {v, n, spots};
}

describe('the burn', () => {
  const {v, n} = graph();
  const from = L.three.chips[0];
  const noteAt = (t: number) => {
    v.notes[0].setValue(t / DUR.roll);
    v.fromIn.setValue(t / DUR.fromIn);
    const top = L.note.landTop + at(n.pool.notes[0].translateY);
    return {top, bottom: top + NOTE_H, opacity: at(n.pool.notes[0].opacity)};
  };

  it('drops straight down from fully behind the card to the number line', () => {
    const start = noteAt(0);
    expect(start.bottom).toBeLessThanOrEqual(L.card.y + L.card.h);
    expect(start.top).toBeGreaterThanOrEqual(L.card.y);
    const end = noteAt(DUR.roll);
    expect(end.top).toBeCloseTo(L.note.landTop, 6);
    // Number-first chips: a docked note never covers the caption.
    expect(noteAt(560).bottom).toBeLessThanOrEqual(
      L.ledgerTop + CHIP_CAPTION_TOP,
    );
  });

  it('keeps the pending FROM total until the opaque note covers it — the slot is never empty', () => {
    range(0, DUR.roll, 1).forEach(t => {
      const note = noteAt(t);
      const pending = at(n.ledger.fromPending);
      const total = at(n.ledger.odo[0].n);
      const covering =
        note.opacity === 1 && Math.abs(note.top - L.note.landTop) < 0.5;
      // Something always reads in the number slot: the grey total, the
      // note resting on it, or the new ink total.
      expect(pending > 0.99 || covering || total > 0.99).toBe(true);
      // The grey total only ever leaves from under a landed note.
      if (pending < 0.99) {
        expect(covering || note.opacity === 0).toBe(true);
      }
    });
    expect(from.x).toBeLessThan(from.cx - NOTE_W / 2);
  });

  it('rests on the number line, then is swapped for the number in ONE frame — never a dissolve', () => {
    // Visible, it is opaque: the 15 sp note "16" and the 20 sp chip "16"
    // are never blended.
    range(41, DUR.roll, 1).forEach(t => {
      const o = noteAt(t).opacity;
      expect(o === 0 || o === 1).toBe(true);
    });
    const last = range(0, DUR.roll, 1)
      .filter(t => noteAt(t).opacity === 1)
      .pop()!;
    expect(last).toBe(NOTE_CUT);
    // A beat of rest on the chip before the swap.
    expect(NOTE_CUT - NOTE_LAND).toBeGreaterThanOrEqual(60);
    const swap = noteAt(last);
    expect(Math.abs(swap.top - L.note.landTop)).toBeLessThan(0.01);
    // Under it, the chip is already showing the new total, at rest.
    expect(at(n.ledger.odo[0].n)).toBe(1);
    expect(at(n.ledger.odo[0].nY)).toBe(0);
    expect(at(n.ledger.fromFilled)).toBe(1);
    expect(at(n.ledger.fromPending)).toBe(0);
    noteAt(last + 1);
    expect(at(n.pool.notes[0].opacity)).toBe(0);
    // Inside the 640 ms burn budget.
    expect(NOTE_CUT + 1).toBeLessThanOrEqual(640);
  });

  it('a second note pushes the old total down out of the slot — a note never sits on a number', () => {
    const glyphHalf = 7;
    let pushed = false;
    range(0, DUR.roll, 1).forEach(t => {
      v.notes[1].setValue(t / DUR.roll);
      const top = L.note.landTop + at(n.pool.notes[1].translateY);
      const shown =
        at(n.pool.notes[1].opacity) > 0 && top + NOTE_H > L.card.y + L.card.h;
      const p = at(n.ledger.odo[1].p);
      const pY = at(n.ledger.odo[1].pY);
      const winTop = L.numberCy - 12;
      const winBottom = L.numberCy + 12;
      const glyphTop = Math.max(winTop, L.numberCy - glyphHalf + pY);
      const glyphBottom = Math.min(winBottom, L.numberCy + glyphHalf + pY);
      if (shown && p > 0 && glyphBottom > glyphTop) {
        // The note's bottom edge may touch the old total, never cover it.
        expect(top + NOTE_H - glyphTop).toBeLessThanOrEqual(1);
      }
      if (pY > 0) {
        pushed = true;
      }
    });
    expect(pushed).toBe(true);
    v.notes[1].setValue(0);
  });
});

describe('the split', () => {
  const ghosts = (three: boolean) => {
    const {v, n, spots} = graph(three);
    const sample = (t: number) => {
      v.split.setValue(t / DUR.split);
      const a = spots.chips[0].cx + at(n.ledger.ghostA.translateX);
      const b = spots.chips[0].cx + at(n.ledger.ghostB.translateX);
      return {
        a,
        b,
        aOn: at(n.ledger.ghostA.opacity) > 0.001,
        bOn: three && at(n.ledger.ghostB.opacity) > 0.001,
      };
    };
    return {v, n, spots, sample};
  };

  it('ghost B (to CHANGE) leads and A never catches it', () => {
    const {sample} = ghosts(true);
    let gap = 0;
    range(0, DUR.split).forEach(t => {
      const g = sample(t);
      expect(g.b).toBeGreaterThanOrEqual(g.a - 1e-9);
      if (t >= SPLIT_ROLL && t <= GHOST_A.land) {
        expect(g.b - g.a).toBeGreaterThanOrEqual(gap - 1e-6);
        gap = g.b - g.a;
      }
    });
    // B slides out from under A and is a whole note clear of it by ~360 ms.
    const apart = range(0, DUR.split).find(
      t => sample(t).b - sample(t).a >= NOTE_W,
    )!;
    expect(apart).toBeLessThanOrEqual(380);
  });

  it('says what happens to the 16 before anything moves: no note carries the burnt total once a second note shows', () => {
    const {sample, n, v} = ghosts(true);
    range(0, DUR.split, 1).forEach(t => {
      const g = sample(t);
      // B never shows the total: it comes out from under A reading "4".
      expect(at(n.ledger.ghostB.from)).toBe(0);
      if (g.bOn && g.b - g.a > 0.5) {
        // Once B shows at all, A already reads 12.
        expect(at(n.ledger.ghostA.from)).toBe(0);
        expect(at(n.ledger.ghostA.to)).toBe(1);
      }
      // Nothing travels until A's label has rolled.
      if (t <= SPLIT_ROLL) {
        expect(g.a).toBeCloseTo(L.three.chips[0].cx, 6);
        expect(g.b).toBeCloseTo(L.three.chips[0].cx, 6);
      }
    });
    v.split.setValue(0);
  });

  it('lands each ghost on its chip and fades it into the settling layer', () => {
    const {sample, n, v} = ghosts(true);
    const end = sample(DUR.split);
    expect(end.a).toBeCloseTo(L.three.chips[1].cx, 6);
    expect(end.b).toBeCloseTo(L.three.chips[2].cx, 6);
    v.split.setValue(1);
    expect(at(n.ledger.paidSettling)).toBe(1);
    expect(at(n.ledger.changeSettling)).toBe(1);
    expect(at(n.ledger.fromSpent)).toBe(1);
    expect(at(n.ledger.ghostA.opacity)).toBe(0);
    expect(at(n.ledger.ghostB.opacity)).toBe(0);
    // Both inside the 640 ms split budget, the cut's one-frame step too.
    expect(GHOST_B.cut + 1).toBeLessThan(DUR.split);
    expect(DUR.split).toBeLessThanOrEqual(640);
  });

  it('rests each ghost on its chip and swaps it for the number in one frame; the settling edge comes up only around a ghost covering the number', () => {
    const {sample, n, v} = ghosts(true);
    const check = (
      ghost: typeof n.ledger.ghostA,
      chipCx: number,
      settling: Num,
      key: 'a' | 'b',
    ) => {
      const cut = range(200, DUR.split, 1).find(t => {
        sample(t);
        return at(ghost.opacity) < 1;
      })!;
      // Swapped out at rest, in one step (opaque until then).
      expect(Math.abs(sample(cut - 1)[key] - chipCx)).toBeLessThan(0.01);
      expect(at(ghost.opacity)).toBe(1);
      sample(cut);
      expect(at(ghost.opacity)).toBe(0);
      expect(at(settling)).toBe(1);
      // The settling layer (edge, tint, number) comes up only while the
      // ghost already covers the number glyph (half a note minus half a
      // 22 dp number).
      range(0, DUR.split, 2).forEach(t => {
        const g = sample(t);
        if (at(settling) > 0 && at(ghost.opacity) > 0) {
          expect(Math.abs(g[key] - chipCx)).toBeLessThanOrEqual(
            NOTE_W / 2 - 11,
          );
        }
      });
      v.split.setValue(1);
    };
    check(n.ledger.ghostA, L.three.chips[1].cx, n.ledger.paidSettling, 'a');
    check(n.ledger.ghostB, L.three.chips[2].cx, n.ledger.changeSettling, 'b');
  });

  it('rolls each label inside its note instead of printing two numbers over each other', () => {
    const {v, n} = ghosts(true);
    [n.ledger.ghostA, n.ledger.ghostB].forEach(g => {
      range(0, DUR.split, 4).forEach(t => {
        v.split.setValue(t / DUR.split);
        const from = at(g.from);
        const to = at(g.to);
        if (from > 0.02 && to > 0.02) {
          // An odometer: old above, new below, a full 18 dp line apart —
          // the two numbers never share a pixel row.
          expect(at(g.fromY)).toBeLessThan(at(g.toY));
          expect(at(g.toY) - at(g.fromY)).toBeGreaterThanOrEqual(18);
        }
      });
      v.split.setValue(1);
      expect(at(g.toY)).toBe(0);
      expect(at(g.to)).toBe(1);
    });
  });

  it("hides FROM's number under ghost A, and brings it back grey only once A is clear of it", () => {
    const {sample, n, v} = ghosts(true);
    const fromCx = L.three.chips[0].cx;
    // The number "16" at 20 sp is ~22 dp wide: half of it plus half a note.
    const clear = NOTE_W / 2 + 11;
    range(1, DUR.split).forEach(t => {
      const g = sample(t);
      const spentLayer = at(n.ledger.fromSpent);
      const spentNum = spentLayer * at(n.ledger.fromSpentNum);
      // The filled (ink) number is under the opaque spent layer at once.
      expect(spentLayer).toBe(1);
      if (Math.abs(g.a - fromCx) < clear) {
        expect(spentNum).toBe(0);
      }
    });
    v.split.setValue(1);
    expect(at(n.ledger.fromSpentNum)).toBe(1);
  });

  it('clears each pending number only under the ghost that claims it — never an empty chip', () => {
    const {sample, n} = ghosts(true);
    const cover = NOTE_W / 2 - 11;
    range(0, DUR.split, 1).forEach(t => {
      const g = sample(t);
      const paid = at(n.ledger.paidPending3);
      const settledPaid = at(n.ledger.paidSettling);
      if (paid < 0.99) {
        // Gone only under A (landing), or once the settling 12 is up.
        expect(
          (g.aOn && Math.abs(g.a - L.three.chips[1].cx) <= cover) ||
            settledPaid > 0.99,
        ).toBe(true);
      }
      const change = at(n.ledger.changePending);
      const settledChange = at(n.ledger.changeSettling);
      if (change < 0.99) {
        expect(
          (g.bOn && Math.abs(g.b - L.three.chips[2].cx) <= cover) ||
            settledChange > 0.99,
        ).toBe(true);
      }
    });
  });

  it('exact bill: the single ghost clears PAID only by covering it, then lands', () => {
    const {sample, n} = ghosts(false);
    const chip = L.two.chips[1];
    range(0, DUR.split, 1).forEach(t => {
      const g = sample(t);
      if (at(n.ledger.paidPending2) < 0.99) {
        expect(
          (g.aOn && Math.abs(g.a - chip.cx) <= NOTE_W / 2 - 11) ||
            at(n.ledger.paidSettling) > 0.99,
        ).toBe(true);
      }
    });
    expect(sample(DUR.split).a).toBeCloseTo(chip.cx, 6);
  });

  it('lights each operator as the money crosses it', () => {
    const {sample, n} = ghosts(true);
    const crossing = (x: number) =>
      range(0, DUR.split).find(t => sample(t).b >= x)!;
    const arrow = crossing(L.three.ops[0]);
    const plus = crossing(L.three.ops[1]);
    sample(arrow + 60);
    expect(at(n.ledger.opLit3[0])).toBeGreaterThan(0);
    sample(plus + 60);
    expect(at(n.ledger.opLit3[1])).toBeGreaterThan(0);
    // ...and not long before: the light rides with the money.
    sample(arrow - 40);
    expect(at(n.ledger.opLit3[0])).toBe(0);
    sample(plus - 40);
    expect(at(n.ledger.opLit3[1])).toBe(0);
  });
});

describe('the change', () => {
  it('rises behind the card in ONE straight move — no lift, no pop — and lights the edge as it goes in', () => {
    const {v, n} = graph();
    const slipAt = (t: number) => {
      v.slips[0].setValue(t / DUR.slip);
      return {
        top: L.note.landTop + at(n.pool.slips[0].translateY),
        scale: at(n.pool.slips[0].scale),
        opacity: at(n.pool.slips[0].opacity),
        glow: at(n.card.glow),
      };
    };
    let prev = slipAt(0).top;
    expect(prev).toBeCloseTo(L.note.landTop, 6);
    range(0, DUR.slip, 2).forEach(t => {
      const s = slipAt(t);
      // Never bigger, never down: one upward travel, no hop.
      expect(s.scale).toBe(1);
      expect(s.top).toBeLessThanOrEqual(prev + 1e-9);
      prev = s.top;
    });
    const hidden = slipAt(SLIP_HIDDEN);
    expect(hidden.top + NOTE_H).toBeLessThanOrEqual(L.card.y + L.card.h);
    expect(hidden.opacity).toBe(0);
    expect(slipAt(520).glow).toBeCloseTo(0.9, 6);
    expect(slipAt(DUR.slip).glow).toBe(0);
    // The whole gesture, glow included, inside the 640 ms change budget.
    expect(DUR.slip).toBeLessThanOrEqual(640);
  });

  it("keeps CHANGE's number as a 35 % placeholder under the rising slip: never two 4s at full, never '12 + [ ]'", () => {
    const {v, n} = graph();
    v.split.setValue(1);
    range(0, DUR.slip, 4).forEach(t => {
      v.slips[0].setValue(t / DUR.slip);
      const chip = at(n.ledger.changeNum) * at(n.ledger.changeSettling);
      const slip = at(n.pool.slips[0].opacity);
      if (slip > 0) {
        expect(chip).toBeLessThanOrEqual(0.35 + 1e-6);
      }
      expect(chip).toBeGreaterThanOrEqual(0.35 - 1e-6);
    });
    v.slips[0].setValue(0);
    expect(at(n.ledger.changeNum)).toBe(1);
    // An unconfirmed write hands the number back to the chip at full
    // strength — even long after the slip itself finished rising.
    v.slips[0].setValue(1);
    expect(at(n.ledger.changeNum)).toBeCloseTo(0.35, 6);
    v.armChange.setValue(1);
    v.errOn.setValue(1);
    v.X.setValue(1);
    expect(at(n.ledger.changeNum)).toBe(1);
  });

  it('turns CHANGE "4 ✓" as a short state change that rests on an exact 1', () => {
    const {v, n} = graph();
    v.changeHome.setValue(0);
    expect(at(n.ledger.changeHome)).toBe(0);
    v.changeHome.setValue(1);
    expect(at(n.ledger.changeHome)).toBe(1);
    expect(DUR.changeHome).toBeLessThanOrEqual(240);
  });
});

describe('the finale', () => {
  const {v, n} = graph();
  const F = (t: number) => v.F.setValue(t / DUR.finale);

  it('lands the check by 360 ms with NO overshoot: it only ever grows', () => {
    let prev = 0;
    range(0, DUR.handoff).forEach(t => {
      F(t);
      const s = at(n.badge.scale);
      expect(s).toBeGreaterThanOrEqual(prev - 1e-9);
      if (t < DUR.handoff - DUR.flood) {
        expect(s).toBeLessThanOrEqual(FINALE_REST_SCALE + 1e-9);
      }
      prev = s;
    });
    F(360);
    expect(at(n.badge.scale)).toBeCloseTo(FINALE_REST_SCALE, 6);
    expect(at(n.badge.opacity)).toBe(1);
  });

  it.each([DUR.handoff, DUR.finale])(
    'is Success frame 0 from the hand-off on (%i ms): badge at the Success centre, full size, flood past every corner',
    t => {
      F(t);
      expect(at(n.badge.scale)).toBe(1);
      expect(L.finale.cy + at(n.badge.translateY)).toBeCloseTo(
        L.finale.successY,
        6,
      );
      expect(at(n.flood.scale)).toBeCloseTo(L.finale.floodEnd, 6);
      expect(at(n.flood.opacity)).toBe(1);
      expect(at(n.rm.overlay)).toBe(1);
    },
  );

  it('hands its last 20 ms before the hand-off to a flat full-screen rect, exactly like Success', () => {
    F(DUR.handoff - 21);
    expect(at(n.rm.overlay)).toBe(0);
    F(DUR.handoff);
    expect(at(n.rm.overlay)).toBe(1);
    expect(at(n.rm.badge)).toBe(0);
    expect(DUR.handoff).toBeLessThanOrEqual(DUR.finale);
  });

  it('lifts the last title away before the paid title is half in: no overprint', () => {
    v.title[0].setValue(1);
    range(0, 400).forEach(t => {
      F(t);
      const paid = at(n.status.paid.opacity);
      const old = at(n.status.titles[0].opacity);
      if (paid >= 0.5) {
        expect(old).toBeLessThanOrEqual(0.05);
      }
      expect(Math.min(paid, old)).toBeLessThanOrEqual(0.3);
    });
    F(240);
    expect(at(n.status.titles[0].translateY)).toBe(-4);
    expect(at(n.status.paid.opacity)).toBe(1);
  });

  it('hides the flood under the badge until it starts to grow', () => {
    const floodAt = DUR.handoff - DUR.flood;
    F(floodAt - 1);
    expect(at(n.flood.scale)).toBeLessThan(at(n.badge.scale));
    F(floodAt - 21);
    expect(at(n.flood.opacity)).toBe(0);
    // The check rests at least 160 ms before the green moves.
    expect(floodAt - 360).toBeGreaterThanOrEqual(160);
  });

  it('fades the hold pill, sheen and verbatim pill out first, and the paid title in', () => {
    v.sheenOn.setValue(1);
    v.holdKeep.setValue(1);
    F(0);
    expect(at(n.card.sheenOpacity)).toBe(1);
    expect(at(n.hold.keep)).toBe(1);
    F(160);
    expect(at(n.card.sheenOpacity)).toBe(0);
    expect(at(n.hold.keep)).toBe(0);
    F(120);
    expect(at(n.status.paid.opacity)).toBe(0);
    F(240);
    expect(at(n.status.paid.opacity)).toBe(1);
  });
});

describe('the error', () => {
  it('shakes once, within 420 ms, back to rest', () => {
    const {v, n} = graph();
    v.errOn.setValue(1);
    let extreme = 0;
    let crossings = 0;
    let last = 0;
    range(0, DUR.error).forEach(t => {
      v.X.setValue(t / DUR.error);
      const x = at(n.card.translateX);
      extreme = Math.max(extreme, Math.abs(x));
      if (
        Math.sign(x) !== 0 &&
        Math.sign(x) !== Math.sign(last) &&
        last !== 0
      ) {
        crossings += 1;
      }
      if (x !== 0) {
        last = x;
      }
      if (t >= 420) {
        expect(Math.abs(x)).toBe(0);
      }
    });
    expect(extreme).toBeGreaterThanOrEqual(9);
    expect(extreme).toBeLessThanOrEqual(10 + 1e-9);
    // [0,-10,9,-6,4,-2,0]: five swings (four reversals), then still.
    expect(crossings).toBe(4);
    expect(at(n.ornaments.translateX)).toBe(0);
  });

  it('never shakes in the PIN pose (the X clock runs for its vetoes only)', () => {
    const {v, n} = graph();
    v.errOn.setValue(0);
    range(0, DUR.error).forEach(t => {
      v.X.setValue(t / DUR.error);
      expect(Math.abs(at(n.card.translateX))).toBe(0);
    });
  });

  it('vetoes a change slip that was still going in: no half-inserted slip, CHANGE keeps its number', () => {
    const {v, n} = graph();
    v.split.setValue(1);
    v.slips[0].setValue(300 / DUR.slip);
    const before = at(n.pool.slips[0].opacity);
    expect(before).toBeGreaterThan(0);
    expect(at(n.ledger.changeNum)).toBeCloseTo(0.35, 6);
    v.armSlip[0].setValue(1);
    v.armChange.setValue(1);
    v.errOn.setValue(1);
    v.X.setValue(1);
    expect(at(n.pool.slips[0].opacity)).toBe(0);
    expect(at(n.ledger.changeHome)).toBe(0);
    expect(at(n.card.glow)).toBe(0);
    expect(at(n.ledger.changeNum)).toBe(1);
    expect(at(n.ledger.changeSettling)).toBe(1);
  });

  it('vetoes a burn in flight: the FROM chip goes back to pending', () => {
    const {v, n} = graph();
    v.notes[0].setValue(550 / DUR.roll);
    v.fromIn.setValue(550 / DUR.fromIn);
    expect(at(n.ledger.fromFilled)).toBeGreaterThan(0);
    v.armNote[0].setValue(1);
    v.armFrom.setValue(1);
    v.X.setValue(1);
    expect(at(n.ledger.fromFilled)).toBe(0);
    expect(at(n.ledger.fromPending)).toBe(1);
    expect(at(n.pool.notes[0].opacity)).toBe(0);
  });
});

describe('the conductor', () => {
  const PLAN: PlanShape = {
    three: true,
    pinRequired: false,
    segments: ['card', 'pay', 'settle', 'change'],
    burns: [16, 8],
    totals: [16, 24],
    changeSat: 7,
    pieces: [4, 2, 1],
    paidSat: 17,
  };

  beforeEach(() => {
    jest.useFakeTimers();
  });
  afterEach(() => {
    jest.clearAllTimers();
    jest.useRealTimers();
  });

  /** Runs phases 50 ms apart (far faster than the gestures) and records every gesture. */
  function runFast(phases: string[]) {
    const v = createValues({mode: 'idle', pose: 'run', planKnown: true});
    const conductor = new Conductor(v, L);
    conductor.configure(L, false, 1);
    const plays: Array<{
      clock: Animated.Value;
      start: number;
      duration: number;
    }> = [];
    const realTiming = Animated.timing;
    const spy = jest
      .spyOn(Animated, 'timing')
      .mockImplementation((value, config) => {
        const c = config as {
          toValue: number;
          duration: number;
          easing?: unknown;
        };
        const from = (
          value as unknown as {__getValue: () => number}
        ).__getValue();
        if (c.toValue === 1 && from <= 0 && c.duration > 0) {
          // play(): the clock starts at -lead/D, so start = now + lead.
          const total = c.duration;
          const D = from < 0 ? total / (1 - from) : total;
          plays.push({
            clock: value as Animated.Value,
            start: performance.now() + (total - D),
            duration: D,
          });
        }
        return realTiming(value, config);
      });
    let stage: StageState = INITIAL_STAGE;
    const snap = (patch: Partial<Snapshot>): Snapshot => ({
      mode: 'running',
      pose: 'run',
      stage,
      stalled: false,
      shape: PLAN,
      planKey: 'p',
      pinError: false,
      pinLength: 0,
      resetKey: 0,
      iosSession: false,
      ...patch,
    });
    conductor.sync(snap({mode: 'idle'}));
    conductor.sync(snap({}));
    phases.forEach((text, i) => {
      stage = mapPhase(stage, {text, seq: i + 1});
      conductor.sync(snap({}));
      jest.advanceTimersByTime(50);
    });
    spy.mockRestore();
    conductor.dispose();
    return {v, plays};
  }

  it('chains dependent gestures with leads: never more than two objects in transit', () => {
    const {v, plays} = runFast([
      'reading card',
      'burning 16 sat (proof 1/2)',
      'burning 8 sat (proof 2/2)',
      'settling payment and minting change',
      'writing change to card',
      'writing change to card',
      'writing change to card',
      'reading card',
    ]);
    const find = (clock: Animated.Value) =>
      plays.filter(p => p.clock === clock);
    const moving: Array<[number, number]> = [];
    v.notes.forEach(clock =>
      find(clock).forEach(p =>
        moving.push([p.start + 80, p.start + NOTE_LAND]),
      ),
    );
    find(v.split).forEach(p => {
      moving.push([p.start + SPLIT_ROLL, p.start + GHOST_B.land]);
      moving.push([p.start + SPLIT_ROLL, p.start + GHOST_A.land]);
    });
    v.slips.forEach(clock =>
      find(clock).forEach(p => moving.push([p.start, p.start + SLIP_HIDDEN])),
    );
    expect(moving).toHaveLength(2 + 2 + 3);
    const end = Math.max(...moving.map(([, b]) => b));
    for (let t = 0; t <= end; t += 5) {
      const inTransit = moving.filter(([a, b]) => t >= a && t < b).length;
      expect(inTransit).toBeLessThanOrEqual(2);
    }
    // Burn 2 waits for burn 1; the split waits for burn 2; the first slip
    // waits for ghost B to land; each slip waits for the one before.
    const [n1] = find(v.notes[0]);
    const [n2] = find(v.notes[1]);
    const [split] = find(v.split);
    const slips = v.slips.slice(0, 3).map(clock => find(clock)[0]);
    // Each follower starts on the frame its leader is swapped for a number.
    expect(n2.start).toBeCloseTo(n1.start + NOTE_CUT, 0);
    expect(split.start).toBeCloseTo(n2.start + NOTE_CUT, 0);
    expect(slips[0].start).toBeCloseTo(split.start + GHOST_B.cut, 0);
    expect(slips[1].start).toBeCloseTo(slips[0].start + SLIP_HIDDEN, 0);
    expect(slips[2].start).toBeCloseTo(slips[1].start + SLIP_HIDDEN, 0);
    // "7 ✓" waits for the closing read AND for the last slip to be home.
    const [home] = find(v.changeHome);
    expect(home.start).toBeCloseTo(slips[2].start + SLIP_HIDDEN, 0);
  });

  it('says "4 ✓" only once a LATER phase confirms the change write', () => {
    const {v, plays} = runFast([
      'reading card',
      'burning 16 sat (proof 1/2)',
      'burning 8 sat (proof 2/2)',
      'settling payment and minting change',
      'writing change to card',
      'writing change to card',
      'writing change to card',
    ]);
    // Every slip went in, but nothing after the last write has arrived.
    expect(plays.filter(p => p.clock === v.changeHome)).toHaveLength(0);
    expect(plays.filter(p => v.slips.includes(p.clock))).toHaveLength(3);
  });

  it('gives CHANGE its number back when the charge fails after the slip went in but before the write was confirmed', () => {
    const v = createValues({mode: 'idle', pose: 'run', planKnown: true});
    const conductor = new Conductor(v, L);
    conductor.configure(L, false, 1);
    let stage: StageState = INITIAL_STAGE;
    const snap = (mode: Snapshot['mode']): Snapshot => ({
      mode,
      pose: 'run',
      stage,
      stalled: false,
      shape: PLAN,
      planKey: 'p',
      pinError: false,
      pinLength: 0,
      resetKey: 0,
      iosSession: false,
    });
    conductor.sync(snap('idle'));
    conductor.sync(snap('running'));
    [
      'reading card',
      'burning 16 sat (proof 1/2)',
      'burning 8 sat (proof 2/2)',
      'settling payment and minting change',
      'writing change to card',
    ].forEach((text, i) => {
      stage = mapPhase(stage, {text, seq: i + 1});
      conductor.sync(snap('running'));
      jest.advanceTimersByTime(2000);
    });
    // Long after the slip finished rising, the card is lost.
    expect(at(v.armChange)).toBe(0);
    conductor.sync(snap('error'));
    expect(at(v.armChange)).toBe(1);
    conductor.dispose();
  });

  it('puts Cancel on the FIRST running frame, and fades the dark CTA out under it (never 54 dp of ink gone in one frame)', () => {
    const v = createValues({mode: 'idle', pose: 'run', planKnown: true});
    const conductor = new Conductor(v, L);
    conductor.configure(L, false, 1);
    const base: Snapshot = {
      mode: 'idle',
      pose: 'run',
      stage: INITIAL_STAGE,
      stalled: false,
      shape: PLAN,
      planKey: 'p',
      pinError: false,
      pinLength: 0,
      resetKey: 0,
      iosSession: false,
    };
    conductor.sync(base);
    expect(at(v.actIdle)).toBe(1);
    const timing = jest.spyOn(Animated, 'timing');
    // The commit that enters running: no timers advance, no frame passes.
    conductor.sync({...base, mode: 'running'});
    const n = buildNodes(v, L, false);
    expect(at(n.actions.run)).toBe(1);
    expect(at(n.status.idleHelper)).toBe(0);
    // The CTA fades for 120 ms (STD) to 0.5, where its layer is already
    // invisible (it shows only above 0.5).
    const fade = timing.mock.calls.find(([value]) => value === v.actIdle);
    expect(fade?.[1]).toMatchObject({toValue: 0.5, duration: 120});
    v.actIdle.setValue(0.5);
    expect(at(n.actions.idle)).toBe(0);
    expect(at(n.actions.run)).toBe(1);
    timing.mockRestore();
    conductor.dispose();
  });

  it('re-enters running from the PIN pose with Cancel on the first frame and every motion overlapping — the sheet, the group and the copy never queue', () => {
    const v = createValues({mode: 'idle', pose: 'pin', planKnown: true});
    const conductor = new Conductor(v, L);
    conductor.configure(L, false, 1);
    const base: Snapshot = {
      mode: 'idle',
      pose: 'pin',
      stage: INITIAL_STAGE,
      stalled: false,
      shape: PLAN,
      planKey: 'p',
      pinError: false,
      pinLength: 4,
      resetKey: 0,
      iosSession: false,
    };
    conductor.sync(base);
    // The PIN is accepted: pose and mode change in one commit.
    conductor.sync({...base, mode: 'running', pose: 'run'});
    const n = buildNodes(v, L, false);
    // Cancel ignores the sheet-gated actions fader: it is drawn above the
    // sheet and is full on the first running frame, with toRun still at 0.
    expect(at(v.toRun)).toBe(0);
    expect(at(n.actions.run)).toBe(1);
    conductor.dispose();

    // The dock, swept in PIN→running time (toRun × 360 ms).
    const t = (ms: number) => v.toRun.setValue(ms / DUR.dock);
    t(0);
    const pinScale = at(n.card.scale);
    const pinCardY = at(n.card.translateY);
    const pinLedgerY = at(n.ledger.translateY);
    expect(pinScale).toBeLessThan(1);
    // Everything starts on the first frame of the move: nothing waits for
    // the sheet to be gone.
    t(20);
    expect(at(n.sheet.opacity)).toBeLessThan(1);
    expect(at(n.card.scale)).toBeGreaterThan(pinScale);
    expect(Math.abs(at(n.card.translateY))).toBeLessThan(Math.abs(pinCardY));
    expect(Math.abs(at(n.ledger.translateY))).toBeLessThan(
      Math.abs(pinLedgerY),
    );
    // The sheet fades out where it is (≤ 24 dp drop) by 160 ms while the
    // running copy comes in on the same curve: the two cross, they never
    // leave a gap between them.
    range(0, 160, 1).forEach(ms => {
      t(ms);
      expect(at(n.sheet.translateY)).toBeLessThanOrEqual(24 + 1e-6);
      expect(at(n.sheet.opacity) + at(n.status.opacity)).toBeGreaterThan(0.99);
    });
    t(160);
    expect(at(n.sheet.opacity)).toBe(0);
    expect(at(n.status.opacity)).toBe(1);
    // The card and ledger grow back as one group over the whole 360 ms.
    t(360);
    expect(at(n.card.scale)).toBe(1);
    expect(at(n.card.translateY)).toBe(0);
    expect(at(n.ledger.translateY)).toBe(0);

    // The hold pill rides the FULL card's top edge: with its copy fully in
    // (w0), it shows only once the card is nearly full size — never
    // printed across the small card's chip, ring and arcs.
    v.holdW0.setValue(1);
    let shown = false;
    range(0, 360, 1).forEach(ms => {
      t(ms);
      const pill = Math.max(at(n.hold.w0), at(n.hold.surface));
      if (at(n.card.scale) < 0.95) {
        expect([ms, pill]).toEqual([ms, 0]);
      }
      if (pill > 0) {
        shown = true;
        // Its band is where the card's top edge is: within 2 dp.
        const top =
          L.card.y +
          at(n.card.translateY) +
          (L.card.h / 2) * (1 - at(n.card.scale));
        expect(Math.abs(top - L.card.y)).toBeLessThan(2);
      }
    });
    expect(shown).toBe(true);
    t(360);
    expect(at(n.hold.w0)).toBe(1);
    expect(at(n.hold.surface)).toBe(1);
  });

  it('never shows the masked id while the card docks into the PIN pose, and brings it back only once the card is nearly full size', () => {
    // The tap flow: running with no plan yet; the plan lands WITH the PIN
    // pose, and the ledger snaps in with it.
    const v = createValues({mode: 'running', pose: 'run', planKnown: false});
    const conductor = new Conductor(v, L);
    conductor.configure(L, false, 1);
    const base: Snapshot = {
      mode: 'running',
      pose: 'run',
      stage: INITIAL_STAGE,
      stalled: false,
      shape: null,
      planKey: null,
      pinError: false,
      pinLength: 0,
      resetKey: 0,
      iosSession: false,
    };
    conductor.sync(base);
    const pin: Snapshot = {
      ...base,
      mode: 'idle',
      pose: 'pin',
      shape: PLAN,
      planKey: 'p',
    };
    conductor.sync(pin);
    const n = buildNodes(v, L, false);
    expect(at(v.ledgerIn)).toBe(1);
    const t = (ms: number) => v.toRun.setValue(ms / DUR.dock);
    // The dock plays PIN→running time backwards, from 360 down to 0: the
    // id is gone from its first frame (the dock alone kept it on at full
    // strength for 200 ms, then faded it).
    range(0, 360, 1)
      .reverse()
      .forEach(ms => {
        t(ms);
        expect([ms, at(n.card.last4)]).toEqual([ms, 0]);
      });
    // The PIN is accepted: back to running in one commit.
    conductor.sync({...pin, mode: 'running', pose: 'run'});
    conductor.dispose();
    let first = -1;
    range(0, 360, 1).forEach(ms => {
      t(ms);
      const id = at(n.card.last4);
      if (at(n.card.scale) < 0.9) {
        expect([ms, id]).toEqual([ms, 0]);
      }
      if (id > 0 && first < 0) {
        first = ms;
      }
    });
    // It comes in over the last third of the move and rests at full.
    expect(first).toBeGreaterThanOrEqual(240);
    t(360);
    expect(at(n.card.last4)).toBe(1);
  });

  it('clears the idle copy and buttons in the finale, whatever pose it starts from', () => {
    const v = createValues({mode: 'idle', pose: 'run', planKnown: true});
    const conductor = new Conductor(v, L);
    conductor.configure(L, false, 1);
    const base: Snapshot = {
      mode: 'idle',
      pose: 'run',
      stage: INITIAL_STAGE,
      stalled: false,
      shape: PLAN,
      planKey: 'p',
      pinError: false,
      pinLength: 0,
      resetKey: 0,
      iosSession: false,
    };
    conductor.sync(base);
    const targets: Array<[Animated.Value, number]> = [];
    const realTiming = Animated.timing;
    const spy = jest
      .spyOn(Animated, 'timing')
      .mockImplementation((value, config) => {
        targets.push([
          value as Animated.Value,
          (config as {toValue: number}).toValue,
        ]);
        return realTiming(value, config);
      });
    conductor.sync({...base, mode: 'complete'});
    spy.mockRestore();
    expect(targets).toContainEqual([v.idleHelper, 0]);
    expect(targets).toContainEqual([v.actIdle, 0]);
    expect(targets).toContainEqual([v.actErr, 0]);
    conductor.dispose();
  });

  it('starts every charge with every verbatim slot hidden: no phase from the last attempt', () => {
    const v = createValues({mode: 'idle', pose: 'run', planKnown: true});
    const conductor = new Conductor(v, L);
    conductor.configure(L, false, 1);
    const base: Snapshot = {
      mode: 'idle',
      pose: 'run',
      stage: INITIAL_STAGE,
      stalled: false,
      shape: PLAN,
      planKey: 'p',
      pinError: false,
      pinLength: 0,
      resetKey: 0,
      iosSession: false,
    };
    conductor.sync(base);
    // A slot left showing (a stale native value, or the failed phase as
    // the error fades on retry)...
    v.pill[1].setValue(1);
    conductor.sync({...base, mode: 'running'});
    v.pill.forEach(value =>
      expect(
        (value as unknown as {__getValue: () => number}).__getValue(),
      ).toBe(2),
    );
    conductor.dispose();
  });

  it.each(['running', 'idle'] as const)(
    "leaves the failed attempt's title and phase hidden when an error gives way to %s",
    next => {
      const v = createValues({mode: 'idle', pose: 'run', planKnown: true});
      const conductor = new Conductor(v, L);
      conductor.configure(L, false, 1);
      const base: Snapshot = {
        mode: 'running',
        pose: 'run',
        stage: INITIAL_STAGE,
        stalled: false,
        shape: PLAN,
        planKey: 'p',
        pinError: false,
        pinLength: 0,
        resetKey: 0,
        iosSession: false,
      };
      conductor.sync({...base, mode: 'idle'});
      conductor.sync(base);
      // The running title and phase were showing when the charge failed.
      v.title[0].setValue(1);
      v.pill[0].setValue(1);
      conductor.sync({...base, mode: 'error'});
      conductor.sync({...base, mode: next});
      [...v.title, ...v.pill].forEach(value =>
        expect(
          (value as unknown as {__getValue: () => number}).__getValue(),
        ).toBe(2),
      );
      conductor.dispose();
    },
  );

  it('snaps every clock back with a native 0 ms timing on a reset, so no finale can linger in JS', () => {
    const v = createValues({mode: 'idle', pose: 'run', planKnown: true});
    const conductor = new Conductor(v, L);
    conductor.configure(L, false, 1);
    const base: Snapshot = {
      mode: 'idle',
      pose: 'run',
      stage: INITIAL_STAGE,
      stalled: false,
      shape: PLAN,
      planKey: 'p',
      pinError: false,
      pinLength: 0,
      resetKey: 0,
      iosSession: false,
    };
    conductor.sync(base);
    conductor.sync({...base, mode: 'running'});
    conductor.sync({...base, mode: 'complete'});
    const snaps: Array<[Animated.Value, number]> = [];
    const realTiming = Animated.timing;
    const spy = jest
      .spyOn(Animated, 'timing')
      .mockImplementation((value, config) => {
        const c = config as {toValue: number; duration: number};
        if (c.duration === 0) {
          snaps.push([value as Animated.Value, c.toValue]);
        }
        return realTiming(value, config);
      });
    // The preview resets mid-finale (a scenario switch).
    conductor.sync({...base, resetKey: 1});
    spy.mockRestore();
    for (const clock of [v.F, v.X, v.split, ...v.notes, ...v.slips]) {
      expect(snaps).toContainEqual([clock, 0]);
    }
    conductor.dispose();
  });

  it('keeps every gesture inside its budget', () => {
    expect(DUR.roll).toBeLessThanOrEqual(640); // burn
    expect(DUR.split).toBeLessThanOrEqual(640);
    expect(DUR.slip).toBeLessThanOrEqual(640); // the change, glow included
    expect(DUR.changeHome).toBeLessThanOrEqual(640);
    expect(DUR.fill).toBeLessThanOrEqual(360); // PIN
    expect(DUR.lockOut).toBeLessThanOrEqual(360); // PIN: the lock opens
    expect(DUR.dock).toBeLessThanOrEqual(360); // PIN pose ↔ running
    expect(DUR.finale).toBe(1200);
    expect(DUR.handoff).toBeLessThanOrEqual(1150);
    expect(DUR.error).toBeLessThanOrEqual(480);
  });

  it('plays two phases that land in one commit as two gestures, in order', () => {
    const v = createValues({mode: 'running', pose: 'run', planKnown: true});
    const conductor = new Conductor(v, L);
    conductor.configure(L, false, 1);
    const started: Animated.Value[] = [];
    const realTiming = Animated.timing;
    const spy = jest
      .spyOn(Animated, 'timing')
      .mockImplementation((value, config) => {
        if ((config as {toValue: number}).toValue === 1) {
          started.push(value as Animated.Value);
        }
        return realTiming(value, config);
      });
    const base: Snapshot = {
      mode: 'running',
      pose: 'run',
      stage: INITIAL_STAGE,
      stalled: false,
      shape: PLAN,
      planKey: 'p',
      pinError: false,
      pinLength: 0,
      resetKey: 0,
      iosSession: false,
    };
    conductor.sync(base);
    // 'burning' and 'settling' batched into one commit.
    const stage = [
      'reading card',
      'burning 16 sat (proof 1/2)',
      'burning 8 sat (proof 2/2)',
      'settling payment and minting change',
    ].reduce((s, text, i) => mapPhase(s, {text, seq: i + 1}), INITIAL_STAGE);
    conductor.sync({...base, stage});
    spy.mockRestore();
    conductor.dispose();
    const order = [v.notes[0], v.notes[1], v.split].map(clock =>
      started.indexOf(clock),
    );
    expect(order.every(i => i >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
  });
});

describe('the graph', () => {
  /**
   * A bare `new Animated.Value` bound straight to a view prop never becomes
   * native; when the graph is rebuilt (reduce motion toggled, a late layout)
   * the native side restores that prop to its default on detach — opacity 1.
   * On the device that showed the hidden flood as a green circle on the card.
   */
  const leaves = (node: unknown, out: unknown[] = []): unknown[] => {
    if (node instanceof Animated.Value) {
      out.push(node);
    } else if (Array.isArray(node)) {
      node.forEach(x => leaves(x, out));
    } else if (
      node &&
      typeof node === 'object' &&
      !(node as {__getValue?: unknown}).__getValue
    ) {
      Object.values(node).forEach(x => leaves(x, out));
    }
    return out;
  };

  it.each([false, true])(
    'binds no view prop to a JS-only value (reduce motion %s)',
    rm => {
      const v = createValues({mode: 'idle', pose: 'run', planKnown: true});
      const n = buildNodes(v, L, rm);
      const warmed = new Set(v.all.map(([value]) => value));
      leaves(n).forEach(leaf => expect(warmed.has(leaf as never)).toBe(true));
    },
  );

  it('holds the stepper slot with one pending track until a plan exists, idle included', () => {
    const v = createValues({mode: 'idle', pose: 'run', planKnown: false});
    const n = buildNodes(v, L, false);
    expect(at(n.stepper.single)).toBe(1);
    // ...not breathing: nothing is in progress at idle.
    expect(at(n.stepper.singleActive)).toBe(0);
    v.ledgerIn.setValue(1);
    expect(at(n.stepper.single)).toBe(0);
    expect(at(n.stepper.segmented)).toBe(1);
  });

  /** Every transform-bound node in the graph, by path. */
  const transforms = (
    node: unknown,
    path = '',
    out: Array<[string, Num]> = [],
  ) => {
    if (node && typeof node === 'object') {
      if ((node as {__getValue?: unknown}).__getValue) {
        const key = path.split('.').pop() ?? '';
        if (
          /translate|scale|shift|^pY$|^nY$|fromY|toY|fillX|sheenX/i.test(key)
        ) {
          out.push([path, node as Num]);
        }
        return out;
      }
      Object.entries(node).forEach(([k, x]) =>
        transforms(x, path ? `${path}.${k}` : k, out),
      );
    }
    return out;
  };
  /** The PIN↔run and iOS-session poses: they may change, but only as cuts. */
  const POSE = new Set([
    'card.translateY',
    'card.scale',
    'ledger.translateY',
    'sheet.translateY',
    'ornaments.translateY',
    'pool.translateY',
    'status.translateY',
    'amount.translateY',
  ]);

  it('under reduce motion binds every translate and scale to a constant: crossfades only', () => {
    const v = createValues({mode: 'running', pose: 'run', planKnown: true});
    const n = buildNodes(v, L, true);
    const nodes = transforms(n);
    expect(nodes.length).toBeGreaterThan(40);
    const read = () => nodes.map(([, node]) => at(node));
    const rest = read();
    // Sweep every value in the graph (clocks, presences, slots, arms) —
    // the poses held still — and nothing that moves may change.
    for (const s of [0, 0.1, 0.25, 0.5, 0.75, 0.9, 1, 1.5, 2]) {
      v.all.forEach(([value]) => value.setValue(s));
      v.toRun.setValue(1);
      v.iosPose.setValue(0);
      v.dxA.setValue(111);
      v.dxB.setValue(223);
      v.segHalf.setValue(30);
      read().forEach((x, i) => {
        if (!POSE.has(nodes[i][0])) {
          expect([nodes[i][0], x]).toEqual([nodes[i][0], rest[i]]);
        }
      });
    }
  });

  it('under reduce motion changes the PIN pose only while card, ledger and sheet are invisible', () => {
    const v = createValues({mode: 'idle', pose: 'pin', planKnown: true});
    const n = buildNodes(v, L, true);
    let prev: number[] | null = null;
    range(0, 1000, 1).forEach(k => {
      v.toRun.setValue(k / 1000);
      const now = [
        at(n.card.scale),
        at(n.card.translateY),
        at(n.ledger.translateY),
        at(n.sheet.translateY),
      ];
      if (prev) {
        if (now.slice(0, 3).some((x, i) => x !== prev![i])) {
          expect(at(n.card.opacity)).toBe(0);
          expect(at(n.ledger.opacity)).toBe(0);
        }
        if (now[3] !== prev[3]) {
          expect(at(n.sheet.opacity)).toBe(0);
        }
      }
      prev = now;
    });
  });

  it("morphs ONE opaque hold-pill surface to the next copy's width: it never fades mid-swap", () => {
    const v = createValues({mode: 'running', pose: 'run', planKnown: true});
    const n = buildNodes(v, L, false);
    v.holdWidths[0].setValue(277);
    v.holdWidths[1].setValue(204);
    const width = () => HOLD_MAX_W - at(n.hold.shiftL) + at(n.hold.shiftR);
    let prev = Infinity;
    range(0, 100, 1).forEach(p => {
      v.holdW0.setValue(1 - p / 100);
      v.holdKeep.setValue(p / 100);
      expect(at(n.hold.surface)).toBeCloseTo(1, 6);
      // The halves stay mirror images, and the width only ever narrows.
      expect(at(n.hold.shiftL)).toBeCloseTo(-at(n.hold.shiftR), 6);
      expect(width()).toBeLessThanOrEqual(prev + 1e-6);
      prev = width();
    });
    v.holdW0.setValue(1);
    v.holdKeep.setValue(0);
    expect(width()).toBeCloseTo(277, 2);
    v.holdW0.setValue(0);
    v.holdKeep.setValue(1);
    expect(width()).toBeCloseTo(204, 2);
    // Nothing shown: the surface is gone (and the divisor is never zero).
    v.holdKeep.setValue(0);
    expect(at(n.hold.surface)).toBe(0);
    expect(Number.isFinite(at(n.hold.shiftL))).toBe(true);
  });

  it('swaps the hold pill copy by fade-through: two pills never overprint', () => {
    const v = createValues({mode: 'running', pose: 'run', planKnown: true});
    const n = buildNodes(v, L, false);
    range(0, 100, 1).forEach(p => {
      v.holdW0.setValue(1 - p / 100);
      v.holdKeep.setValue(p / 100);
      expect(Math.min(at(n.hold.w0), at(n.hold.keep))).toBe(0);
    });
    expect(at(n.hold.keep)).toBe(1);
  });

  it('swaps the bottom action out, then in: never two half-faded actions', () => {
    const v = createValues({mode: 'idle', pose: 'run', planKnown: true});
    const n = buildNodes(v, L, false);
    range(0, 100, 1).forEach(p => {
      v.actIdle.setValue(1 - p / 100);
      v.actRun.setValue(p / 100);
      const idle = at(n.actions.idle);
      const run = at(n.actions.run);
      expect(Math.min(idle, run)).toBe(0);
    });
  });
});

describe('the text slots', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });
  afterEach(() => {
    jest.clearAllTimers();
    jest.useRealTimers();
  });

  it('swap as a fade-through: the outgoing and incoming texts are never both visible', () => {
    const incoming = new Animated.Value(0);
    const outgoing = new Animated.Value(1);
    const a = slot(incoming);
    const b = slot(outgoing);
    range(0, 100, 1).forEach(k => {
      incoming.setValue(k / 100);
      outgoing.setValue(1 + k / 100);
      expect(Math.min(at(a.opacity), at(b.opacity))).toBe(0);
    });
    // Each still travels its 4 dp, and rests fully shown.
    incoming.setValue(0);
    expect(at(a.translateY)).toBe(4);
    incoming.setValue(1);
    expect(at(a.opacity)).toBe(1);
    outgoing.setValue(2);
    expect(at(b.translateY)).toBe(-4);
  });

  it('sinks a text replaced mid-entry back down instead of swelling it through full strength', () => {
    const ring = new SlotRing();
    const values = [0, 1, 2].map(() => new Animated.Value(2));
    const targets: Array<[Animated.Value, number]> = [];
    const realTiming = Animated.timing;
    const spy = jest
      .spyOn(Animated, 'timing')
      .mockImplementation((value, config) => {
        targets.push([
          value as Animated.Value,
          (config as {toValue: number}).toValue,
        ]);
        return realTiming(value, config);
      });
    const clock = jest.spyOn(performance, 'now');
    const step = (ms: number, text: string, instant = false) => {
      clock.mockReturnValue(ms);
      targets.length = 0;
      ring.desire(text, instant);
      ring.flush(values, 120, 'STD', 1);
    };
    step(1000, 'Waiting for the card', true);
    step(5000, 'Reading the card');
    // 'verifying PIN' can land ~30 ms after 'reading card'.
    step(5030, 'Checking the PIN');
    expect(targets).toContainEqual([values[1], 0]);
    expect(targets).not.toContainEqual([values[1], 2]);
    // A settled text leaves over the top as usual.
    step(9000, 'Taking 16 sats off the card');
    expect(targets).toContainEqual([values[2], 2]);
    spy.mockRestore();
    clock.mockRestore();
  });
});
