'use strict';
/**
 * Pure helpers for the simulator e2e runner (scripts/e2e-flashcard.mjs):
 * the 2.0 card's format-4 secret, hex, the fixture each Maestro flow starts
 * from, the block-header stub's answers, and where the cardsim client is.
 * No network, no dependencies (fs and require are passed in) — jest pins it
 * (__tests__/scripts/e2eLib.test.ts).
 */

/** The PIN every PIN-card flow sets and types. */
const PIN = '1234';

/**
 * The bill every charge flow rings up, in sats. It must stay sub-cent so the
 * keypad's SAT entry goes straight to the card charge instead of a BTCPay
 * invoice (Keypad.tsx: 1-cent invoice minimum): 3 sats is sub-cent at any
 * BTC price under $333k.
 */
const BILL_SAT = 3;

/** The proof the card holds when a charge starts: change is 8 - 3 = 5 = 4 + 1. */
const CARD_SAT = 8;

/** The proof the owed-change flow's second charge pays with, exactly. */
const NEXT_SAT = 4;

/** A protocol 2.0 cashu-javacard holds 128 proof slots. */
const CARD_SLOTS = 128;

/** The daily limit the limit-refusal flow sets: under the 3-sat bill. */
const DAY_LIMIT_SAT = 2;

/**
 * How long `back-during-change-write` holds each change LOAD at the bridge
 * (`holdLoad`, src/services/cardBridge.ts): long enough for Maestro to see
 * the change-write title, swipe and read the screen again while the write is
 * still in flight on a slow hosted runner. 4 s was not (run 38200361080: the
 * charge had reached Success by the time Maestro looked), so this is the
 * bridge's 10 s cap.
 */
const HOLD_LOAD_MS = 10000;

/**
 * The format-4 secret of an undated piece locked to the card (cashu-javacard
 * spec/NUT-XX.md), byte-identical to `buildCardSigAllSecret`
 * (src/services/cashuMint.ts). The card rebuilds this text from the nonce
 * and its key when it signs a payment, and the app rebuilds it for the swap;
 * a fixture minted with any other serialization is a piece the mint refuses
 * after the card has burned it.
 */
function cardSecret(nonce, cardPubkey) {
  return JSON.stringify([
    'P2PK',
    {
      nonce: nonce.toLowerCase(),
      data: cardPubkey.toLowerCase(),
      tags: [['sigflag', 'SIG_ALL']],
    },
  ]);
}

/** Lower-case hex of a byte array / Uint8Array. */
function toHex(bytes) {
  return Array.from(bytes, b => (b & 0xff).toString(16).padStart(2, '0')).join(
    '',
  );
}

/** Labels for the 1-sat proofs that fill a card: F1 … Fn. */
function fillerLabels(count) {
  return Array.from({length: count}, (_, i) => `F${i + 1}`);
}

const FULL_FILLERS = fillerLabels(CARD_SLOTS - 1);

/**
 * What each flow needs minted (label → sats) and the card states it posts to
 * cardsim, by stage name. A stage is a fresh card unless it says `onTop`:
 * `/reset`, then `/fixture` with the record (the mint), the TEST owner and
 * the tip header as its anchor (the card's clock), then its pieces. An
 * `onTop` stage is applied to the card as the flow left it (no `/reset`:
 * the card's change openings must survive), after a `CLEAR_SPENT` when it
 * says `clearSpent`. `proofs` are labels into `mint`, loaded in order into
 * the free slots, each with the mint's DLEQ; `spentSlots` are indexes into
 * `proofs`, spent on the card only. `limits` are the owner's. `link` is
 * extra query for the card-bridge deep link.
 *
 * The flow YAML posts each stage from the env var `FIXTURE_<STAGE>`.
 */
const FLOWS = {
  'balance-read': {
    mint: {P8: CARD_SAT},
    stages: {INITIAL: {pin: PIN, proofs: ['P8']}},
  },
  'charge-with-change': {
    mint: {P8: CARD_SAT},
    stages: {INITIAL: {pin: PIN, proofs: ['P8']}},
  },
  'charge-no-pin': {
    mint: {P8: CARD_SAT},
    stages: {INITIAL: {proofs: ['P8']}},
  },
  'full-card-refusal': {
    mint: {P8: CARD_SAT, ...Object.fromEntries(FULL_FILLERS.map(l => [l, 1]))},
    stages: {
      INITIAL: {
        pin: PIN,
        proofs: ['P8', ...FULL_FILLERS],
        spentSlots: FULL_FILLERS.map((_, i) => i + 1),
      },
    },
  },
  'owed-change-next-tap': {
    mint: {
      P8: CARD_SAT,
      P4: NEXT_SAT,
      ...Object.fromEntries(FULL_FILLERS.map(l => [l, 1])),
    },
    stages: {
      // The read plans against a card with room for the change …
      INITIAL: {pin: PIN, proofs: ['P8']},
      // … which is full by the time the PIN is entered: same P8 (live at
      // the mint), every other slot loaded and spent.
      FULL: {
        pin: PIN,
        proofs: ['P8', ...FULL_FILLERS],
        spentSlots: FULL_FILLERS.map((_, i) => i + 1),
      },
      // The same card, on top: its spent slots freed (the change openings
      // of the 4 + 1 it is owed stay on it), then P4. P8 is spent at the
      // mint now and must not come back; P4 pays the second bill exactly,
      // after the owed 4 + 1 go on.
      AFTER: {onTop: true, clearSpent: true, proofs: ['P4']},
    },
  },
  'lost-load-answer': {
    mint: {P8: CARD_SAT},
    // A PIN card. The keypad's balance tap after the charge is the tap
    // after a payment: the card's change grant lets the 1 sat still owed go
    // on with no PIN, and the 4 whose answer was lost is never sent again.
    stages: {INITIAL: {pin: PIN, proofs: ['P8']}},
    link: {dropLoad: 1},
  },
  'limit-refusal': {
    mint: {P8: CARD_SAT},
    // The owner's daily limit is under the bill: refused before the PIN
    // pad, nothing burned.
    stages: {
      INITIAL: {pin: PIN, proofs: ['P8'], limits: {day: DAY_LIMIT_SAT}},
    },
  },
  'back-during-change-write': {
    mint: {P8: CARD_SAT},
    stages: {INITIAL: {pin: PIN, proofs: ['P8']}},
    // Every change LOAD is held before it reaches the card, so the flow can
    // swipe back while the change write is in flight (ENG-645). Two pieces
    // (4 + 1): an 8 s window from the first "Putting 5 sats on the card".
    link: {holdLoad: HOLD_LOAD_MS},
  },
};

const FLOW_NAMES = Object.keys(FLOWS);

/**
 * A cardsim `/fixture` body for one stage. `minted` maps each label to a
 * card piece `{keysetId, amount, nonce, C, dleq}`. `card` is what a fresh
 * card is set up with: `{mint}` (the record) and `{anchor}` (the tip header
 * the TEST owner is set with). An `onTop` stage carries its pieces only.
 */
function buildFixture(stage, minted, card = {}) {
  const body = {};
  if (!stage.onTop) {
    if (stage.pin) {
      body.pin = stage.pin;
    }
    body.mint = card.mint || PLACEHOLDER_MINT;
    body.owner = true;
    if (card.anchor) {
      body.anchor = card.anchor;
    }
  }
  body.proofs = stage.proofs.map(label => {
    const proof = minted[label];
    if (!proof) {
      throw new Error(`no minted proof for ${label}`);
    }
    return {
      keysetId: proof.keysetId,
      amount: proof.amount,
      nonce: proof.nonce,
      C: proof.C,
      ...(proof.dleq ? {dleq: {...proof.dleq}} : {}),
    };
  });
  if (stage.spentSlots && stage.spentSlots.length > 0) {
    body.spentSlots = [...stage.spentSlots];
  }
  if (stage.limits) {
    body.limits = {...stage.limits};
  }
  return body;
}

/** The record's mint for --dry-run's fixtures. */
const PLACEHOLDER_MINT = 'http://127.0.0.1:3338';

/** Placeholder pieces for --dry-run: well-formed, never minted. */
function placeholderProofs(flow) {
  const out = {};
  Object.entries(FLOWS[flow].mint).forEach(([label, amount], i) => {
    out[label] = {
      keysetId: '00'.repeat(8),
      amount,
      nonce: (i + 1).toString(16).padStart(64, '0'),
      C: `02${'00'.repeat(32)}`,
      dleq: {e: '11'.repeat(32), s: '22'.repeat(32), r: '33'.repeat(32)},
    };
  });
  return out;
}

/**
 * The card-bridge deep link a flow opens. `headerApi` is the runner's
 * block-header stub (an Esplora API base), which the app then takes the
 * tip header from instead of mempool.space (`blockHeader.ts`).
 */
function bridgeLink(bridgeUrl, flow, headerApi) {
  const params = [`url=${encodeURIComponent(bridgeUrl)}`];
  const link = FLOWS[flow].link || {};
  if (link.dropLoad) {
    params.push(`dropLoad=${link.dropLoad}`);
  }
  if (link.holdLoad) {
    params.push(`holdLoad=${link.holdLoad}`);
  }
  if (headerApi) {
    params.push(`headers=${encodeURIComponent(headerApi)}`);
  }
  return `flashpos://dev/card-bridge?${params.join('&')}`;
}

/**
 * What the block-header stub answers (an Esplora API, the two routes the app
 * asks): `GET <base>/blocks/tip/hash` and `GET <base>/block/<hash>/header`.
 * `tip` is `{hash, header}` (hex). Anything else is a 404.
 */
function headerStubAnswer(path, tip) {
  const route = path.replace(/^.*?(\/blocks?\/)/, '$1');
  if (route === '/blocks/tip/hash') {
    return {status: 200, body: tip.hash};
  }
  if (route === `/block/${tip.hash}/header`) {
    return {status: 200, body: tip.header};
  }
  return {status: 404, body: 'not found'};
}

/**
 * The newest header of cashu-javacard's `spec/vectors/headers.json`: real
 * mainnet work, so a 2.0 card's floor takes it. Every fresh card is set up
 * with it as its anchor, and the stub serves it as the tip, so a flow's
 * clock is the run's to choose and does not move under it.
 */
function tipFromVectors(vectors) {
  const headers = vectors && vectors.headers;
  if (!Array.isArray(headers) || headers.length === 0) {
    throw new Error('headers.json holds no headers');
  }
  const tip = headers.reduce((a, b) => (b.height > a.height ? b : a));
  if (
    !/^[0-9a-f]{160}$/i.test(tip.header) ||
    !/^[0-9a-f]{64}$/i.test(tip.hash)
  ) {
    throw new Error(
      `headers.json's tip is not a header: ${JSON.stringify(tip)}`,
    );
  }
  return {hash: tip.hash.toLowerCase(), header: tip.header.toLowerCase()};
}

/** Where headers.json sits beside a cashu-javacard checkout's client.cjs. */
function headerVectorsPath(clientPath) {
  return clientPath.replace(
    /tools\/cardsim\/client\.cjs$/,
    'spec/vectors/headers.json',
  );
}

/**
 * Where the cardsim client lives in a cashucard/javacard checkout. The
 * runner talks to the bridge only through that client (tools/cardsim/
 * client.cjs at the pinned ref): its 5 s per-request deadline is what turns
 * a bridge wedged on its single card thread into a failed flow instead of a
 * run that hangs until the job timeout, and its `validateFixture` refuses a
 * malformed stage in the runner's own stack before the bridge answers 400.
 */
const CARDSIM_CLIENT_IN_CHECKOUT = 'tools/cardsim/client.cjs';

/**
 * The client path, first match wins: `--cardsim-client`, then the
 * CARDSIM_CLIENT env var, then the e2e workflow's checkout (`cardsim/` in the
 * repo root), then a sibling cashu-javacard checkout. `exists` is injected
 * (fs.existsSync in the runner) so jest can pin the order. Returns null when
 * nothing is found; an explicit flag or env path is returned as given, so a
 * typo fails loudly in `requireCardSimClient` instead of falling through.
 */
function resolveCardSimClient({flag, env, root, exists}) {
  if (flag) {
    return flag;
  }
  if (env) {
    return env;
  }
  const candidates = [
    `${root}/cardsim/${CARDSIM_CLIENT_IN_CHECKOUT}`,
    `${root}/../cashu-javacard/${CARDSIM_CLIENT_IN_CHECKOUT}`,
  ];
  return candidates.find(candidate => exists(candidate)) || null;
}

/**
 * Loads the cardsim client module and checks it is the one the runner was
 * written against: a CardSim with reset/fixture/state, and the
 * `validateFixture` the runner checks every stage with (the flows post
 * their later stages through Maestro's own http, which validates nothing).
 */
function requireCardSimClient(clientPath, requireFn) {
  if (!clientPath) {
    throw new Error(
      'no cardsim client: pass --cardsim-client <cashu-javacard>/' +
        `${CARDSIM_CLIENT_IN_CHECKOUT} (or set CARDSIM_CLIENT), at the ref ` +
        'pinned in .github/workflows/e2e-flashcard.yml',
    );
  }
  let mod;
  try {
    mod = requireFn(clientPath);
  } catch (error) {
    throw new Error(
      `cannot load the cardsim client at ${clientPath}: ${
        error instanceof Error ? error.message : error
      }`,
    );
  }
  const CardSim = mod && mod.CardSim;
  const proto = CardSim && CardSim.prototype;
  if (
    typeof CardSim !== 'function' ||
    !['reset', 'fixture', 'state'].every(m => typeof proto[m] === 'function')
  ) {
    throw new Error(
      `${clientPath} is not the cardsim client (no CardSim with reset/fixture/state)`,
    );
  }
  if (typeof mod.validateFixture !== 'function') {
    throw new Error(
      `${clientPath} is not the cardsim client (no validateFixture)`,
    );
  }
  return mod;
}

/**
 * The client module (through `requireCardSimClient`, so the same checks and
 * errors) and a `CardSim` on `bridgeUrl` built from it. The runner needs
 * both: the sim for reset/fixture/state, the module's `validateFixture` for
 * the stages the flows post themselves. `options` go to the CardSim
 * constructor ({fetch, timeoutMs}).
 */
function loadCardSim(clientPath, bridgeUrl, requireFn, options) {
  const client = requireCardSimClient(clientPath, requireFn);
  return {client, sim: new client.CardSim(bridgeUrl, options)};
}

/** How long the warm-up gives each APDU: a cold JVM, not a wedged bridge. */
const WARM_TIMEOUT_MS = 60_000;

/**
 * Runs the applet's read and signing paths once on `sim` (a CardSim built
 * with WARM_TIMEOUT_MS), before any flow. A fresh cardsim JVM answers its
 * first APDUs slowly (class loading, the first secp256k1 operations), and
 * on a hosted runner that is past the app's 5 s bridge deadline: the
 * flow's first card read then fails as "no answer". AUTH runs the BIP-340
 * signing code a payment uses without spending anything; a card that
 * refuses it (a status word) is still warm. A transport failure is not
 * tolerated. Leaves no state a flow depends on: every flow starts with
 * /reset. Returns the elapsed milliseconds.
 */
async function warmCardSim(sim, client, now = Date.now) {
  const start = now();
  await sim.select();
  await sim.getInfo();
  await sim.getPubkey();
  await sim.getBalance();
  await sim.getSlotStatus();
  try {
    await sim.auth(Buffer.alloc(16, 0x5a));
  } catch (error) {
    if (!(error instanceof client.CardError)) {
      throw error;
    }
  }
  return now() - start;
}

/**
 * Every stage of a flow through the client's `validateFixture`. Only the
 * runner's INITIAL stage is posted through the client (`sim.fixture`); FULL
 * and AFTER reach the bridge from inside the flow (post-fixture.js, Maestro's
 * http), where a malformed body would be a bare 400 mid-flow. Checked here,
 * a drifted stage fails the run in the runner's stack, naming the flow and
 * the stage, before anything is posted. Throws on the first bad stage.
 */
function validateStages(client, flow, fixtures) {
  for (const [stage, body] of Object.entries(fixtures)) {
    try {
      client.validateFixture(body);
    } catch (error) {
      throw new Error(
        `${flow} ${stage} fixture: ${
          error instanceof Error ? error.message : error
        }`,
      );
    }
  }
}

/** Every stage of every named flow, on placeholder proofs: no mint needed. */
function validateFlows(client, flows) {
  for (const flow of flows) {
    const proofs = placeholderProofs(flow);
    validateStages(
      client,
      flow,
      Object.fromEntries(
        Object.entries(FLOWS[flow].stages).map(([stage, spec]) => [
          stage,
          buildFixture(spec, proofs),
        ]),
      ),
    );
  }
}

/**
 * Hosted macOS runners fail whole flows for reasons outside the app: the
 * Maestro iOS driver not starting, the TEST API never answering the login,
 * a held LOAD outrun by a slow step (runs 38503213894, 38585692095). Each
 * attempt is a fresh start (new proofs, card reset, fixture posted, app
 * relaunched with clear state), so a flow gets FLOW_ATTEMPTS tries and
 * passes on the first that does. A pass that needed a retry is reported as
 * such, never hidden.
 */
const FLOW_ATTEMPTS = 2;

/**
 * Run `attempt(n)` (1-based) until it resolves true or `attempts` are spent.
 * A throw counts as a failed attempt and is handed to `onFail`. Resolves
 * {ok, attempts: the number used}.
 */
async function runAttempts(attempts, attempt, onFail = () => {}) {
  const max = Math.max(1, Math.floor(attempts));
  for (let n = 1; n <= max; n++) {
    let ok = false;
    try {
      ok = (await attempt(n)) === true;
    } catch (error) {
      onFail(n, error);
    }
    if (ok) {
      return {ok: true, attempts: n};
    }
  }
  return {ok: false, attempts: max};
}

module.exports = {
  BILL_SAT,
  CARD_SAT,
  CARD_SLOTS,
  DAY_LIMIT_SAT,
  HOLD_LOAD_MS,
  NEXT_SAT,
  FLOWS,
  FLOW_ATTEMPTS,
  FLOW_NAMES,
  PIN,
  bridgeLink,
  buildFixture,
  cardSecret,
  headerStubAnswer,
  headerVectorsPath,
  loadCardSim,
  PLACEHOLDER_MINT,
  placeholderProofs,
  requireCardSimClient,
  resolveCardSimClient,
  runAttempts,
  tipFromVectors,
  toHex,
  validateFlows,
  validateStages,
  WARM_TIMEOUT_MS,
  warmCardSim,
};
