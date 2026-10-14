#!/usr/bin/env node
/**
 * Simulator e2e for the eCash card (ENG-634): real proofs, a real applet,
 * the production UI.
 *
 *   cardsim  (lnflash/cashu-javacard tools/cardsim) — the applet in jCardSim
 *            on http://127.0.0.1:9876; the app reaches it through the dev
 *            card bridge (src/services/cardBridge.ts).
 *   mint     a local Nutshell on FakeWallet (http://127.0.0.1:3338): proofs
 *            are minted for free and settle for real.
 *   app      a Debug build on a booted iOS simulator, driven by Maestro
 *            through .maestro/flashcard/<flow>.yaml.
 *
 * Per flow: mint the flow's pieces locked to the card in the 2.0 format-4
 * SIG_ALL form, exactly as the card and the app rebuild them, each with the
 * mint's DLEQ; /reset the card (and check its key did not change); post the
 * INITIAL fixture (the record, the TEST owner anchored at the tip header,
 * the pieces); then run the flow with every later stage's fixture (and the
 * nonces) in its environment. A local block-header stub serves the same tip
 * to the app (the deep link's `headers=`), so a flow's card clock never
 * moves under it.
 *
 *   node scripts/e2e-flashcard.mjs --username <TEST merchant> [--flow a,b]
 *       [--bridge http://127.0.0.1:9876] [--mint http://127.0.0.1:3338]
 *       [--device <simulator id>] [--cardsim-client <path to client.cjs>]
 *   node scripts/e2e-flashcard.mjs --dry-run      # plan only, no network
 *
 * Exit 0 only when every selected flow passed. Run book: docs/10-testing.md.
 */
import {spawnSync} from 'node:child_process';
import {randomBytes} from 'node:crypto';
import {existsSync, readFileSync} from 'node:fs';
import {createServer} from 'node:http';
import {createRequire} from 'node:module';
import {dirname, join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

const require = createRequire(import.meta.url);
const lib = require('./e2e-flashcard/lib.cjs');

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const FLOW_DIR = join(ROOT, '.maestro', 'flashcard');

const USAGE = `usage: node scripts/e2e-flashcard.mjs [options]
  --username <name>   TEST merchant username the app logs in with (or FLASH_USERNAME)
  --flow <a,b>        flows to run (default: all): ${lib.FLOW_NAMES.join(', ')}
  --bridge <url>      cardsim bridge (default http://127.0.0.1:9876)
  --mint <url>        FakeWallet mint (default http://127.0.0.1:3338)
  --device <id>       simulator for Maestro (when more than one is booted)
  --cardsim-client <path>
                      lnflash/cashu-javacard tools/cardsim/client.cjs (or
                      CARDSIM_CLIENT; default: ./cardsim/ or ../cashu-javacard/)
  --dry-run           print the plan with placeholder proofs; no network, no Maestro
  --help`;

function parseArgs(argv) {
  const opts = {
    bridge: 'http://127.0.0.1:9876',
    mint: 'http://127.0.0.1:3338',
    username: process.env.FLASH_USERNAME || '',
    flows: [],
    device: '',
    cardsimClient: '',
    dryRun: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const [flag, inline] = arg.includes('=') ? arg.split(/=(.*)/s) : [arg];
    const value = () => {
      if (inline !== undefined) {
        return inline;
      }
      const next = argv[++i];
      if (next === undefined || next.startsWith('--')) {
        throw new Error(`${flag} needs a value`);
      }
      return next;
    };
    switch (flag) {
      case '--bridge':
        opts.bridge = value();
        break;
      case '--mint':
        opts.mint = value();
        break;
      case '--username':
        opts.username = value();
        break;
      case '--device':
        opts.device = value();
        break;
      case '--cardsim-client':
        opts.cardsimClient = value();
        break;
      case '--flow':
        opts.flows.push(...value().split(',').filter(Boolean));
        break;
      case '--dry-run':
        opts.dryRun = true;
        break;
      case '--help':
      case '-h':
        console.log(USAGE);
        process.exit(0);
        break;
      default:
        throw new Error(`unknown option ${arg}\n${USAGE}`);
    }
  }
  opts.bridge = opts.bridge.replace(/\/+$/, '');
  opts.mint = opts.mint.replace(/\/+$/, '');
  if (opts.flows.length === 0) {
    opts.flows = [...lib.FLOW_NAMES];
  }
  for (const flow of opts.flows) {
    if (!lib.FLOWS[flow]) {
      throw new Error(
        `unknown flow ${flow}; known: ${lib.FLOW_NAMES.join(', ')}`,
      );
    }
  }
  if (!opts.dryRun && !opts.username) {
    throw new Error('--username (or FLASH_USERNAME) is required');
  }
  return opts;
}

// ---------------------------------------------------------------- cardsim

/** Client path: --cardsim-client, CARDSIM_CLIENT, cardsim/, ../cashu-javacard. */
function cardSimClientPath(opts) {
  return lib.resolveCardSimClient({
    flag: opts.cardsimClient && resolve(opts.cardsimClient),
    env: process.env.CARDSIM_CLIENT && resolve(process.env.CARDSIM_CLIENT),
    root: ROOT,
    exists: existsSync,
  });
}

/**
 * The bridge's CardSim, through the merged reference client
 * (lnflash/cashu-javacard tools/cardsim/client.cjs): every request has its
 * 5 s deadline, a fixture is validated locally before it is posted, and a
 * 409 (a fixture step the applet refused) arrives as its CardSimError naming
 * the step. Returned with the client module it came from: the module's
 * `validateFixture` checks the stages the flows post themselves (through
 * Maestro's http), which never pass through the CardSim.
 */
function openCardSim(opts) {
  return lib.loadCardSim(cardSimClientPath(opts), opts.bridge, require);
}

/** /reset, then prove the card key survived it (minted proofs depend on it). */
async function resetCard(sim, expectedPubkey) {
  const state = await sim.reset();
  if (!state.deterministicKey) {
    throw new Error('cardsim no longer promises a deterministic key');
  }
  if (expectedPubkey && state.pubkey !== expectedPubkey) {
    throw new Error(
      `cardsim rotated the card key on /reset (${expectedPubkey} → ${state.pubkey}); proofs minted to the old key are dead`,
    );
  }
  return state;
}

// ------------------------------------------------------------------- mint

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function loadMint(mintUrl) {
  const {Mint} = await import('@cashu/cashu-ts');
  const mint = new Mint(mintUrl);
  const {keysets} = await mint.getKeySets();
  // An 8-byte id (forge's) is stored whole; a 33-byte NUT-02 v2 id (a fresh
  // Nutshell 0.20.3's) by its first 8 bytes, which the app expands back.
  const active = keysets.find(
    k =>
      k.unit === 'sat' &&
      k.active &&
      /^[0-9a-f]{16}([0-9a-f]{50})?$/i.test(k.id),
  );
  if (!active) {
    throw new Error(
      `${mintUrl} has no active sat keyset with an 8- or 33-byte id: ${JSON.stringify(
        keysets.map(k => k.id),
      )}`,
    );
  }
  const {keysets: withKeys} = await mint.getKeys(active.id);
  const keyset = withKeys.find(k => k.id === active.id);
  if (!keyset) {
    throw new Error(`${mintUrl} did not return keys for ${active.id}`);
  }
  return {mint, keyset};
}

/**
 * Mints `amounts` (label → sats) locked to the card as 2.0 pieces: a random
 * nonce, the format-4 SIG_ALL secret (`lib.cardSecret`, byte-identical to
 * `buildCardSigAllSecret`), blinded over its UTF-8 bytes. Each piece keeps
 * the mint's DLEQ (e, s and the blinding factor r), which the card stores
 * beside it (LOAD_PROOF P1 = 1) and the app checks offline.
 */
async function mintCardProofs({mint, keyset}, cardPubkey, amounts) {
  const {Amount, OutputData, blindMessage} = await import('@cashu/cashu-ts');
  const {utf8ToBytes} = await import('@noble/hashes/utils');
  const entries = Object.entries(amounts);
  const total = entries.reduce((sum, [, sats]) => sum + sats, 0);

  const quote = await mint.createMintQuoteBolt11({amount: total, unit: 'sat'});
  const deadline = Date.now() + 30_000;
  for (;;) {
    const status = await mint.checkMintQuoteBolt11(quote.quote);
    if (status.state === 'PAID') {
      break;
    }
    if (status.state === 'ISSUED') {
      throw new Error(`mint quote ${quote.quote} was already issued`);
    }
    if (Date.now() > deadline) {
      throw new Error(
        `mint quote ${quote.quote} still ${status.state} after 30 s — is the mint on FakeWallet?`,
      );
    }
    await sleep(250);
  }

  const outputs = entries.map(([label, sats]) => {
    const nonce = randomBytes(32).toString('hex');
    const secretBytes = utf8ToBytes(lib.cardSecret(nonce, cardPubkey));
    const {r, B_} = blindMessage(secretBytes);
    const rHex = r.toString(16).padStart(64, '0');
    const data = new OutputData(
      {
        id: keyset.id,
        amount: Amount.from(sats),
        B_: lib.toHex(B_.toBytes(true)),
      },
      r,
      secretBytes,
    );
    return {label, sats, nonce, data, rHex};
  });
  const {signatures} = await mint.mintBolt11({
    quote: quote.quote,
    outputs: outputs.map(o => o.data.blindedMessage),
  });
  if (signatures.length !== outputs.length) {
    throw new Error(
      `mint signed ${signatures.length} of ${outputs.length} outputs`,
    );
  }
  const minted = {};
  outputs.forEach((o, i) => {
    const proof = o.data.toProof(signatures[i], keyset);
    if (proof.secret !== lib.cardSecret(o.nonce, cardPubkey)) {
      throw new Error(`${o.label}: unblinded secret drifted from the card's`);
    }
    const dleq = signatures[i].dleq;
    if (!dleq) {
      throw new Error(`${o.label}: the mint gave no DLEQ proof`);
    }
    minted[o.label] = {
      keysetId: keyset.id.toLowerCase().slice(0, 16),
      amount: o.sats,
      nonce: o.nonce,
      C: proof.C,
      dleq: {e: String(dleq.e), s: String(dleq.s), r: o.rHex},
    };
  });
  return minted;
}

// --------------------------------------------------------- block headers

/**
 * The tip header every card is anchored at and the app is shown: the
 * newest of cashu-javacard's `spec/vectors/headers.json` (real mainnet work,
 * so the applet's floor takes it), from the checkout the client came from.
 */
function loadTip(clientPath) {
  const path = clientPath && lib.headerVectorsPath(clientPath);
  if (!path || !existsSync(path)) {
    throw new Error(
      `no spec/vectors/headers.json beside the cardsim client (${clientPath}); pass the client of a cashu-javacard checkout`,
    );
  }
  return lib.tipFromVectors(JSON.parse(readFileSync(path, 'utf8')));
}

/**
 * A local Esplora stand-in on 127.0.0.1 (an ephemeral port) that serves
 * `tip` and nothing else. Resolves to its base URL and a close function.
 */
function startHeaderStub(tip) {
  return new Promise((resolveStub, reject) => {
    const server = createServer((req, res) => {
      const answer = lib.headerStubAnswer(req.url || '', tip);
      res.writeHead(answer.status, {'content-type': 'text/plain'});
      res.end(answer.body);
    });
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const {port} = server.address();
      resolveStub({
        base: `http://127.0.0.1:${port}/api`,
        close: () => new Promise(done => server.close(() => done())),
      });
    });
  });
}

// ---------------------------------------------------------------- flows

function maestroArgs(opts, flow, fixtures, minted) {
  const env = {
    BRIDGE_URL: opts.bridge,
    BRIDGE_LINK: lib.bridgeLink(opts.bridge, flow, opts.headerApi),
    FLASH_USERNAME: opts.username || '<username>',
    BILL_SAT: String(lib.BILL_SAT),
    PIN: lib.PIN,
    NONCES: JSON.stringify(
      Object.fromEntries(Object.entries(minted).map(([l, p]) => [l, p.nonce])),
    ),
  };
  for (const [stage, body] of Object.entries(fixtures)) {
    env[`FIXTURE_${stage}`] = JSON.stringify(body);
  }
  const args = opts.device ? ['--device', opts.device, 'test'] : ['test'];
  for (const [key, value] of Object.entries(env)) {
    args.push('-e', `${key}=${value}`);
  }
  args.push(join(FLOW_DIR, `${flow}.yaml`));
  return args;
}

function fixturesFor(flow, minted, card) {
  return Object.fromEntries(
    Object.entries(lib.FLOWS[flow].stages).map(([stage, spec]) => [
      stage,
      lib.buildFixture(spec, minted, card),
    ]),
  );
}

function shorten(arg) {
  return arg.length > 160 ? `${arg.slice(0, 157)}...` : arg;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const maestro = process.env.MAESTRO || 'maestro';

  if (opts.dryRun) {
    console.log(`dry run: ${opts.flows.length} flow(s), no network`);
    // Local only: the stages against the reference validator, when a
    // cashu-javacard checkout is found.
    const clientPath = cardSimClientPath(opts);
    if (clientPath) {
      lib.validateFlows(
        lib.requireCardSimClient(clientPath, require),
        opts.flows,
      );
      console.log(`fixtures validated by ${clientPath}\n`);
    } else {
      console.log('fixtures not validated: no cardsim client found\n');
    }
    opts.headerApi = 'http://127.0.0.1:<stub>/api';
    for (const flow of opts.flows) {
      const minted = lib.placeholderProofs(flow);
      const fixtures = fixturesFor(flow, minted, {mint: opts.mint});
      const mintTotal = Object.values(lib.FLOWS[flow].mint).reduce(
        (a, b) => a + b,
        0,
      );
      console.log(
        `# ${flow}: mint ${mintTotal} sat as ${
          Object.keys(minted).length
        } proof(s)`,
      );
      for (const [stage, body] of Object.entries(fixtures)) {
        console.log(
          `  ${stage}: pin=${body.pin ? 'yes' : 'no'} owner=${
            body.owner ? 'yes' : 'no'
          } proofs=${body.proofs.length} spent=${
            (body.spentSlots || []).length
          }${body.limits ? ` limits=${JSON.stringify(body.limits)}` : ''}${
            lib.FLOWS[flow].stages[stage].onTop ? ' (on top, no reset)' : ''
          }`,
        );
      }
      console.log(
        `  ${maestro} ${maestroArgs(opts, flow, fixtures, minted)
          .map(shorten)
          .join(' ')}\n`,
      );
    }
    return 0;
  }

  const {client, sim} = openCardSim(opts);
  // Every stage of every flow against the reference validator before a sat
  // is minted: FULL and AFTER are posted mid-flow by post-fixture.js through
  // Maestro's http, so this is the only check they get before the bridge.
  lib.validateFlows(client, opts.flows);
  const first = await sim.state();
  const pubkey = first.pubkey;
  console.log(
    `cardsim ${opts.bridge}: card ${pubkey.slice(0, 16)}… (applet ${
      first.realVersion
    })`,
  );
  // The first APDUs on a fresh cardsim JVM are slow; pay that here, not
  // against the app's 5 s deadline in the first flow's card read.
  const {sim: warmSim} = lib.loadCardSim(
    cardSimClientPath(opts),
    opts.bridge,
    require,
    {timeoutMs: lib.WARM_TIMEOUT_MS},
  );
  const warmMs = await lib.warmCardSim(warmSim, client);
  console.log(`cardsim warmed in ${(warmMs / 1000).toFixed(1)} s`);
  const mint = await loadMint(opts.mint);
  console.log(`mint ${opts.mint}: keyset ${mint.keyset.id}`);
  const tip = loadTip(cardSimClientPath(opts));
  const stub = await startHeaderStub(tip);
  opts.headerApi = stub.base;
  console.log(
    `block headers: ${stub.base} serves tip ${tip.hash.slice(0, 16)}…`,
  );
  const card = {mint: opts.mint, anchor: tip.header};

  const attempts = Number(process.env.E2E_FLOW_ATTEMPTS) || lib.FLOW_ATTEMPTS;
  const results = [];
  for (const flow of opts.flows) {
    const outcome = await lib.runAttempts(
      attempts,
      async n => {
        console.log(
          `\n=== ${flow}${n > 1 ? ` (attempt ${n} of ${attempts})` : ''}`,
        );
        const minted = await mintCardProofs(mint, pubkey, lib.FLOWS[flow].mint);
        const fixtures = fixturesFor(flow, minted, card);
        // Again on the minted proofs, which the placeholders only stand in for.
        lib.validateStages(client, flow, fixtures);
        // The flow starts on this card; later stages are its own to post.
        await resetCard(sim, pubkey);
        const state = await sim.fixture(fixtures.INITIAL);
        console.log(
          `card: ${state.balance} sat, ${state.counts.unspent} unspent / ${state.counts.spent} spent / ${state.counts.empty} empty`,
        );
        const run = spawnSync(
          maestro,
          maestroArgs(opts, flow, fixtures, minted),
          {
            stdio: 'inherit',
            cwd: ROOT,
          },
        );
        if (run.error) {
          throw run.error;
        }
        return run.status === 0;
      },
      (n, error) =>
        console.error(
          `${flow} (attempt ${n}): ${
            error instanceof Error ? error.message : error
          }`,
        ),
    );
    if (outcome.ok && outcome.attempts > 1) {
      // Visible in the PR's checks, so a flow that keeps needing a retry is
      // looked at rather than absorbed.
      console.log(
        `::warning::e2e flow ${flow} passed on attempt ${outcome.attempts} of ${attempts}`,
      );
    }
    results.push({flow, ...outcome});
  }

  await stub.close();
  console.log('\n=== results');
  for (const {flow, ok, attempts: used} of results) {
    console.log(
      `${ok ? 'PASS' : 'FAIL'}  ${flow}${
        used > 1 ? `  (${used} attempts)` : ''
      }`,
    );
  }
  return results.every(r => r.ok) ? 0 : 1;
}

main().then(
  code => process.exit(code),
  error => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(2);
  },
);
