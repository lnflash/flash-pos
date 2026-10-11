import {buildCardP2PKSecret} from '../../src/services/cashuMint';

// The e2e runner's pure half (scripts/e2e-flashcard/lib.cjs). Plain CommonJS
// so Node runs it with no build step; jest loads it the same way.
const lib = require('../../scripts/e2e-flashcard/lib.cjs');

describe('cardSecret', () => {
  // A fixture whose secret differs from the app's by one byte is a proof the
  // mint rejects AFTER the card has burned its slot: the drift this pins.
  it.each([
    ['lower-case inputs', 'ab'.repeat(32), `02${'cd'.repeat(32)}`],
    ['upper-case inputs', 'AB'.repeat(32), `03${'CD'.repeat(32)}`],
    ['mixed-case inputs', 'aB'.repeat(32), `02${'Cd'.repeat(32)}`],
  ])(
    'is byte-identical to buildCardP2PKSecret for %s',
    (_label, nonce, pubkey) => {
      expect(lib.cardSecret(nonce, pubkey)).toBe(
        buildCardP2PKSecret(nonce, pubkey),
      );
    },
  );

  it('keeps the sigflag tag cashu-ts would drop', () => {
    expect(lib.cardSecret('00', '02aa')).toContain('["sigflag","SIG_INPUTS"]');
  });
});

describe('toHex', () => {
  it('writes lower-case, zero-padded hex for arrays and Uint8Arrays', () => {
    expect(lib.toHex([0, 1, 0xab, 0xff])).toBe('0001abff');
    expect(lib.toHex(new Uint8Array([0x0f, 0xf0]))).toBe('0ff0');
  });
});

describe('FLOWS', () => {
  const minted = (flow: string) => lib.placeholderProofs(flow);

  it('has a Maestro flow for every fixture and nothing else', () => {
    const fs = require('fs');
    const path = require('path');
    const dir = path.join(__dirname, '../../.maestro/flashcard');
    const yaml = fs
      .readdirSync(dir)
      .filter((f: string) => f.endsWith('.yaml'))
      .map((f: string) => f.replace(/\.yaml$/, ''))
      .sort();
    expect(yaml).toEqual([...lib.FLOW_NAMES].sort());
  });

  it('keeps the bill sub-cent and the change two pieces (4 + 1)', () => {
    expect(lib.BILL_SAT).toBe(3);
    expect(lib.CARD_SAT - lib.BILL_SAT).toBe(5);
  });

  it('the full-card fixture holds 32 proofs, 31 of them spent, the bill proof live in slot 0', () => {
    const body = lib.buildFixture(
      lib.FLOWS['full-card-refusal'].stages.INITIAL,
      minted('full-card-refusal'),
    );
    expect(body.proofs).toHaveLength(lib.CARD_SLOTS);
    expect(body.spentSlots).toHaveLength(lib.CARD_SLOTS - 1);
    expect(body.spentSlots).not.toContain(0);
    expect(body.proofs[0].amount).toBe(lib.CARD_SAT);
    expect(body.pin).toBe(lib.PIN);
  });

  it('owed-change: the FULL stage keeps the very proof the read planned, and AFTER never brings it back', () => {
    const proofs = minted('owed-change-next-tap');
    const {INITIAL, FULL, AFTER} = lib.FLOWS['owed-change-next-tap'].stages;
    const initial = lib.buildFixture(INITIAL, proofs);
    const full = lib.buildFixture(FULL, proofs);
    const after = lib.buildFixture(AFTER, proofs);

    expect(full.proofs[0]).toEqual(initial.proofs[0]);
    expect(full.spentSlots).toHaveLength(lib.CARD_SLOTS - 1);
    expect(after.proofs.map((p: {nonce: string}) => p.nonce)).not.toContain(
      initial.proofs[0].nonce,
    );
    expect(after.proofs[0].amount).toBe(lib.NEXT_SAT);
  });

  it('only the PIN-less flow posts a card without a PIN', () => {
    const pinless = lib.FLOW_NAMES.filter((flow: string) =>
      Object.values(
        lib.FLOWS[flow].stages as Record<string, {pin?: string}>,
      ).some(stage => !stage.pin),
    );
    expect(pinless).toEqual(['charge-no-pin']);
  });

  it('every placeholder proof is the shape cardsim accepts', () => {
    for (const flow of lib.FLOW_NAMES) {
      for (const proof of Object.values(minted(flow)) as {
        keysetId: string;
        nonce: string;
        C: string;
        amount: number;
      }[]) {
        expect(proof.keysetId).toMatch(/^[0-9a-f]{16}$/);
        expect(proof.nonce).toMatch(/^[0-9a-f]{64}$/);
        expect(proof.C).toMatch(/^0[23][0-9a-f]{64}$/);
        expect(proof.amount).toBeGreaterThan(0);
      }
    }
  });

  it('refuses a stage that names a proof nobody minted', () => {
    expect(() => lib.buildFixture({proofs: ['NOPE']}, {})).toThrow(
      'no minted proof for NOPE',
    );
  });
});

describe('bridgeLink', () => {
  it('encodes the bridge URL and adds dropLoad only where the flow asks', () => {
    expect(lib.bridgeLink('http://127.0.0.1:9876', 'balance-read')).toBe(
      'flashpos://dev/card-bridge?url=http%3A%2F%2F127.0.0.1%3A9876',
    );
    expect(lib.bridgeLink('http://127.0.0.1:9876', 'lost-load-answer')).toBe(
      'flashpos://dev/card-bridge?url=http%3A%2F%2F127.0.0.1%3A9876&dropLoad=1',
    );
  });

  it('builds links the app parses back to the same bridge', () => {
    const {parseCardBridgeLink} = require('../../src/services/cardBridge');
    expect(
      parseCardBridgeLink(
        lib.bridgeLink('http://127.0.0.1:9876', 'lost-load-answer'),
      ),
    ).toEqual({
      action: 'set',
      config: {url: 'http://127.0.0.1:9876', dropLoad: 1},
    });
  });
});

describe('the cardsim client', () => {
  const fs = require('fs');
  const os = require('os');
  const path = require('path');

  describe('resolveCardSimClient', () => {
    const none = () => false;

    it('takes --cardsim-client first, then CARDSIM_CLIENT, as given', () => {
      expect(
        lib.resolveCardSimClient({
          flag: '/a/client.cjs',
          env: '/b/client.cjs',
          root: '/r',
          exists: none,
        }),
      ).toBe('/a/client.cjs');
      expect(
        lib.resolveCardSimClient({
          env: '/b/client.cjs',
          root: '/r',
          exists: none,
        }),
      ).toBe('/b/client.cjs');
    });

    it("then the workflow's cardsim/ checkout, then a sibling cashu-javacard", () => {
      const ci = '/r/cardsim/tools/cardsim/client.cjs';
      const sibling = '/r/../cashu-javacard/tools/cardsim/client.cjs';
      expect(lib.resolveCardSimClient({root: '/r', exists: () => true})).toBe(
        ci,
      );
      expect(
        lib.resolveCardSimClient({
          root: '/r',
          exists: (p: string) => p === sibling,
        }),
      ).toBe(sibling);
      expect(lib.resolveCardSimClient({root: '/r', exists: none})).toBeNull();
    });

    it('the workflow passes the path its cashu-javacard checkout puts it at', () => {
      const workflow = fs.readFileSync(
        path.join(__dirname, '../../.github/workflows/e2e-flashcard.yml'),
        'utf8',
      );
      expect(workflow).toMatch(/^\s+path: cardsim$/m);
      expect(workflow).toContain(
        '--cardsim-client cardsim/tools/cardsim/client.cjs',
      );
    });
  });

  describe('loadCardSim', () => {
    let dir: string;
    beforeEach(() => {
      dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cardsim-client-'));
    });
    afterEach(() => fs.rmSync(dir, {recursive: true, force: true}));

    const write = (name: string, body: string) => {
      const file = path.join(dir, name);
      fs.writeFileSync(file, body);
      return file;
    };

    it('says how to point at the client when none was found', () => {
      expect(() =>
        lib.loadCardSim(null, 'http://127.0.0.1:9876', require),
      ).toThrow(/--cardsim-client .*tools\/cardsim\/client\.cjs/);
    });

    it('fails loudly on a path that is not there (no silent fallback)', () => {
      expect(() =>
        lib.loadCardSim(
          path.join(dir, 'missing.cjs'),
          'http://127.0.0.1:9876',
          require,
        ),
      ).toThrow(/cannot load the cardsim client at .*missing\.cjs/);
    });

    it('refuses a module that is not the cardsim client', () => {
      const file = write('other.cjs', 'module.exports = {CardSim: class {}};');
      expect(() =>
        lib.loadCardSim(file, 'http://127.0.0.1:9876', require),
      ).toThrow(/is not the cardsim client/);
    });

    it("refuses a client with no validateFixture (the flows' stages need it)", () => {
      const file = write(
        'old.cjs',
        `class CardSim { reset() {} fixture() {} state() {} }
         module.exports = {CardSim};`,
      );
      expect(() =>
        lib.loadCardSim(file, 'http://127.0.0.1:9876', require),
      ).toThrow(/is not the cardsim client \(no validateFixture\)/);
    });

    it('requireCardSimClient hands back the module itself', () => {
      const file = write(
        'mod.cjs',
        `class CardSim { reset() {} fixture() {} state() {} }
         module.exports = {CardSim, validateFixture: f => f, marker: 7};`,
      );
      expect(lib.requireCardSimClient(file, require).marker).toBe(7);
    });

    it("builds the client's CardSim on the bridge URL with the options", () => {
      const file = write(
        'client.cjs',
        `class CardSim {
           constructor(url, opts) { this.url = url; this.opts = opts; }
           reset() {} fixture() {} state() {}
         }
         module.exports = {CardSim, validateFixture: f => f};`,
      );
      const sim = lib.loadCardSim(file, 'http://127.0.0.1:9876', require, {
        timeoutMs: 1234,
      });
      expect(sim.url).toBe('http://127.0.0.1:9876');
      expect(sim.opts).toEqual({timeoutMs: 1234});
    });
  });

  // FULL and AFTER are posted mid-flow by post-fixture.js through Maestro's
  // http, never through the client; the runner's validateFlows is the only
  // check they get. Runs in plain CI with a recording stand-in.
  describe('validateFlows', () => {
    it('checks every stage of every flow, mid-flow ones included', () => {
      const seen: unknown[] = [];
      lib.validateFlows(
        {validateFixture: (f: unknown) => seen.push(f)},
        lib.FLOW_NAMES,
      );
      const stages = lib.FLOW_NAMES.flatMap((flow: string) =>
        Object.keys(lib.FLOWS[flow].stages),
      );
      expect(seen).toHaveLength(stages.length);
      expect(stages).toEqual(expect.arrayContaining(['FULL', 'AFTER']));
    });

    it('names the flow and the stage a validator refused', () => {
      const flow = 'owed-change-next-tap';
      const stages = Object.keys(lib.FLOWS[flow].stages);
      let calls = 0;
      const client = {
        // Refuses the last stage only, so the error must name that one.
        validateFixture: () => {
          calls += 1;
          if (calls === stages.length) {
            throw new TypeError('refused');
          }
        },
      };
      expect(() => lib.validateFlows(client, [flow])).toThrow(
        `${flow} ${stages[stages.length - 1]} fixture: refused`,
      );
    });
  });

  // The reference client itself, when a cashu-javacard checkout is next to
  // this repo (locally) or in cardsim/ (the e2e workflow). The plain jest CI
  // job has neither and skips this.
  const real = lib.resolveCardSimClient({
    root: path.join(__dirname, '../..'),
    exists: fs.existsSync,
  });
  (real ? describe : describe.skip)('through the reference client', () => {
    it('a bridge that stops answering fails the call instead of hanging', async () => {
      const wedged = (_url: string, init: {signal: AbortSignal}) =>
        new Promise((_resolve, reject) => {
          init.signal.addEventListener('abort', () =>
            reject(new Error('aborted by the deadline')),
          );
        });
      const sim = lib.loadCardSim(real, 'http://127.0.0.1:9876', require, {
        fetch: wedged,
        timeoutMs: 50,
      });
      await expect(sim.reset()).rejects.toThrow('aborted by the deadline');
      await expect(sim.state()).rejects.toThrow('aborted by the deadline');
    });

    it('refuses a malformed fixture before anything is posted', async () => {
      const fetch = jest.fn();
      const sim = lib.loadCardSim(real, 'http://127.0.0.1:9876', require, {
        fetch,
      });
      expect(() =>
        sim.fixture({proofs: [{keysetId: 'zz', amount: 1, nonce: '', C: ''}]}),
      ).toThrow(/keysetId must be 8 bytes/);
      expect(fetch).not.toHaveBeenCalled();
    });

    it('the runner refuses a drifted mid-flow stage before anything is posted', () => {
      const client = require(real);
      const flow = 'owed-change-next-tap';
      const good = Object.fromEntries(
        Object.entries(lib.FLOWS[flow].stages).map(([stage, spec]) => [
          stage,
          lib.buildFixture(spec, lib.placeholderProofs(flow)),
        ]),
      ) as Record<string, {proofs: Array<Record<string, unknown>>}>;
      expect(() => lib.validateStages(client, flow, good)).not.toThrow();
      const drifted = {
        ...good,
        FULL: {
          ...good.FULL,
          proofs: [{...good.FULL.proofs[0], keysetId: 'zz'}],
        },
      };
      expect(() => lib.validateStages(client, flow, drifted)).toThrow(
        /owed-change-next-tap FULL fixture: .*keysetId must be 8 bytes/,
      );
    });

    it('accepts every stage the flows post', () => {
      const {validateFixture} = require(real);
      for (const flow of lib.FLOW_NAMES) {
        for (const spec of Object.values(lib.FLOWS[flow].stages)) {
          expect(() =>
            validateFixture(
              lib.buildFixture(spec, lib.placeholderProofs(flow)),
            ),
          ).not.toThrow();
        }
      }
    });
  });
});

describe('flows that pin a known bug', () => {
  const fs = require('fs');
  const path = require('path');
  const dir = path.join(__dirname, '../../.maestro/flashcard');

  // A PIN card whose change write fails after the swap falls back into the
  // PIN pad (ENG-642). Every flow that asserts that pad line after a PIN
  // must say it pins a bug, so the fix reads as a fix, not a regression.
  it.each(['owed-change-next-tap', 'lost-load-answer'])(
    '%s marks its pin-error-text assertion KNOWN BUG ENG-642',
    flow => {
      const text: string = fs.readFileSync(
        path.join(dir, `${flow}.yaml`),
        'utf8',
      );
      const at = text.indexOf("id: 'pin-error-text'");
      expect(at).toBeGreaterThan(-1);
      expect(text.slice(0, at)).toMatch(
        /# KNOWN BUG ENG-642: pins today's wrong behaviour[\s\S]*error-body/,
      );
    },
  );

  it('no other flow asserts the PIN pad line', () => {
    const others = fs
      .readdirSync(dir)
      .filter((f: string) => f.endsWith('.yaml'))
      .filter(
        (f: string) =>
          !['owed-change-next-tap.yaml', 'lost-load-answer.yaml'].includes(f),
      );
    for (const f of others) {
      expect(fs.readFileSync(path.join(dir, f), 'utf8')).not.toContain(
        'pin-error-text',
      );
    }
  });
});
