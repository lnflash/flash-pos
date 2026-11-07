'use strict';
/**
 * The phone in the card relay harness (ENG-821,
 * __tests__/integration/cardRelayDemo.test.ts): a separate Node process that
 * reads the 2.2 card's outbox and settles the payment with cashu-card's
 * portable relay engine (tools/assisted-relay/relay.js). It is given only its
 * own public folder, the card bridge and the mint: never the till's store.
 *
 *   node scripts/card-relay/phone.cjs <cashu-card checkout> <phone folder> \
 *     <cardsim origin> <mint origin> capture|settle|race|replay
 *
 * capture  a new tap: SELECT, then GET_OUTBOX (INS 1B) P1 = 00 for the 45-byte
 *          scope and P1 = 01 pages (offset(2) ‖ count(1)), through
 *          capturePacket; writes captured.json (the decoded public packet).
 * settle   reconcilePayment at the mint. The mint's answer to the swap is
 *          dropped, so the engine must find its outputs by restore.
 * race     settle, but held at a barrier just before /v1/swap: race-ready.json
 *          is written and the swap waits for race-go.json; race-done.json is
 *          written once the mint has answered it.
 * replay   reconcilePayment again: it must submit no swap.
 *
 * Each mode writes <mode>-result.json. Loopback services only.
 */
const fs = require('node:fs');
const path = require('node:path');

const LOGICAL_MINT = 'https://cashucard-relay.invalid';
const APPLET_SELECT = '00a404000bf04341534855434152440100';
const GET_PUBKEY = 'b010000021';
const BARRIER_MS = 30000;

function loopback(value) {
  const url = new URL(value);
  if (
    url.protocol !== 'http:' ||
    !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) ||
    url.pathname !== '/' ||
    url.search ||
    url.hash ||
    url.username ||
    url.password
  ) {
    throw new Error('the phone reaches loopback services only');
  }
  return url.origin;
}

function writePrivate(file, value) {
  fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n', {
    flag: 'wx',
    mode: 0o600,
  });
}

/** One APDU over cardsim's /apdu; a non-9000 status word throws. */
function cardOver(origin) {
  return async hex => {
    const response = await fetch(origin + '/apdu', {
      method: 'POST',
      headers: {'content-type': 'application/json'},
      body: JSON.stringify({hex}),
      redirect: 'error',
      signal: AbortSignal.timeout(15000),
    });
    if (!response.ok) {
      throw new Error('cardsim /apdu: HTTP ' + response.status);
    }
    const {hex: answer, sw} = await response.json();
    if (sw !== '9000') {
      const error = new Error('card answered ' + sw);
      error.sw = sw;
      throw error;
    }
    return [...Buffer.from(answer.slice(0, -4), 'hex')];
  };
}

const outboxScope = () => 'b01b000000';
const outboxPage = (offset, count) =>
  'b01b010003' +
  Buffer.from([offset >> 8, offset & 0xff, count]).toString('hex') +
  '00';

async function main() {
  const [cashuCard, folder, cardsim, mint, mode] = process.argv.slice(2);
  if (
    ![cashuCard, folder].every(v => v && path.isAbsolute(v)) ||
    !['capture', 'settle', 'race', 'replay'].includes(mode)
  ) {
    throw new Error(
      'usage: phone.cjs <cashu-card> <folder> <cardsim> <mint> capture|settle|race|replay',
    );
  }
  const tools = path.join(cashuCard, 'tools');
  const {capturePacket, decodePacket, reconcilePayment} = require(path.join(
    tools,
    'assisted-relay/relay.js',
  ));
  const {crypto} = require(path.join(tools, 'assisted-relay/node-adapter.cjs'));
  const {localHTTP} = require(path.join(
    tools,
    'assisted-relay/local-http.cjs',
  ));
  const {withPhaseJournal} = require(path.join(
    tools,
    'outbox-spike/phase-journal.cjs',
  ));
  const journalFile = path.join(folder, 'relay.json');

  if (mode === 'capture') {
    const card = cardOver(loopback(cardsim));
    // A new tap, with no PIN: what an owner's phone sends.
    const select = await card(APPLET_SELECT);
    // The card key comes from the card (GET_PUBKEY on this same tap), never
    // from the packet it is about to verify: a key read out of the packet
    // would make decodePacket's signature check prove nothing.
    const cardKey = Buffer.from(await card(GET_PUBKEY)).toString('hex');
    if (cardKey.length !== 66) {
      throw new Error('GET_PUBKEY: expected a 33-byte compressed key');
    }
    // The installation is not read by any command but GET_OUTBOX; the phone
    // pins it from this card's first page (the bridge's install draws it),
    // as cardsim's outbox.test.cjs policyOf does.
    const head = await card(outboxPage(0, 72));
    const policy = {
      mint: LOGICAL_MINT,
      cardKey,
      installation: Buffer.from(head.slice(40, 72)).toString('hex'),
    };
    writePrivate(path.join(folder, 'policy.json'), policy);
    let captured;
    await withPhaseJournal(
      journalFile,
      {format: 'private-assisted-relay-v1', state: 'capturing'},
      async ({save}) => {
        captured = await capturePacket({
          policy,
          crypto,
          save,
          readScope: () => card(outboxScope()),
          readPage: (offset, count) => card(outboxPage(offset, count)),
        });
      },
    );
    const packet = decodePacket(
      [...Buffer.from(captured.packet, 'hex')],
      policy,
      crypto,
    );
    writePrivate(path.join(folder, 'capture-result.json'), {
      select: Buffer.from(select).toString('hex'),
      // The key the phone verified the packet against: GET_PUBKEY's answer.
      policyCardKey: policy.cardKey,
      bytes: captured.packet.length / 2,
      packetId: packet.packetId,
      mint: packet.mint,
      cardKey: packet.cardKey,
      witness: packet.witness,
      paymentMessage: packet.paymentMessage,
      inputs: packet.inputs.map(i => ({
        id: i.id,
        amount: i.amount,
        secret: i.secret,
        C: i.C,
      })),
      outputs: packet.outputs,
    });
    return;
  }

  const policy = JSON.parse(
    fs.readFileSync(path.join(folder, 'policy.json'), 'utf8'),
  );
  const http = localHTTP(loopback(mint));
  let swaps = 0;
  const request = async (route, body) => {
    if (route === '/v1/swap') {
      swaps += 1;
      if (mode === 'race') {
        writePrivate(path.join(folder, 'race-ready.json'), {});
        const started = Date.now();
        while (!fs.existsSync(path.join(folder, 'race-go.json'))) {
          if (Date.now() - started > BARRIER_MS) {
            throw new Error('race barrier timed out');
          }
          await new Promise(resolve => setTimeout(resolve, 10));
        }
      }
    }
    let answer;
    try {
      answer = await http(route, body);
    } finally {
      if (route === '/v1/swap' && mode === 'race') {
        // The mint has answered this swap (taken it or refused it).
        writePrivate(path.join(folder, 'race-done.json'), {});
      }
    }
    if (route === '/v1/swap' && mode === 'settle') {
      // Accepted by the mint, never seen by the phone.
      throw new Error('injected lost swap response');
    }
    return answer;
  };
  let result;
  const unresolved = [];
  // A swap the mint is still processing (the other side of a race) reads as
  // `pending`, or, once its promises are stored but before its inputs are
  // marked spent, as the engine's `settlement-unresolved` failure, which
  // keeps the journal as it was. Either way the engine is asked again.
  for (let attempt = 0; attempt < 20; attempt++) {
    result = undefined;
    try {
      await withPhaseJournal(
        journalFile,
        undefined,
        async ({journal, save}) => {
          result = await reconcilePayment({
            journal,
            policy,
            crypto,
            request,
            save,
          });
        },
      );
    } catch (error) {
      if (!error || error.code !== 'settlement-unresolved') {
        throw error;
      }
      unresolved.push(await observe(http, folder));
    }
    if (result && result.state !== 'pending') {
      break;
    }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  if (!result || result.state !== 'outputs-confirmed') {
    throw new Error(
      'relay did not confirm the outputs: ' +
        (result ? result.state : 'unresolved x' + unresolved.length) +
        ' ' +
        JSON.stringify(unresolved),
    );
  }
  writePrivate(path.join(folder, mode + '-result.json'), {
    state: result.state,
    packetId: result.evidence.packetId,
    inputsSpent: result.evidence.inputsSpent,
    outputs: result.evidence.outputs.length,
    swapCalls: swaps,
    unresolved,
  });
}

/**
 * The mint's full keyset id for each 8-byte id the packet names: the one id
 * in its catalogue that starts with it. On a legacy (8-byte) mint this is the
 * id itself; on a v2 (33-byte) mint, the full id restore must be asked under.
 * Returns {error} instead when a prefix names no keyset or more than one.
 */
async function fullKeysetIds(http, ids) {
  const catalogue = await http('/v1/keysets');
  const known = (catalogue && catalogue.keysets ? catalogue.keysets : []).map(
    k => k.id,
  );
  const full = {};
  for (const id of new Set(ids)) {
    const matches = known.filter(k => k.startsWith(id));
    if (matches.length !== 1) {
      return {error: matches.length ? 'keyset-ambiguous' : 'keyset-unknown'};
    }
    full[id] = matches[0];
  }
  return {full};
}

/**
 * What the mint showed when the engine called the settlement unresolved:
 * how many of the packet's outputs restore returned, and the inputs' states.
 * Kept in the result so a run shows the transient it rode out.
 */
async function observe(http, folder) {
  const captured = JSON.parse(
    fs.readFileSync(path.join(folder, 'capture-result.json'), 'utf8'),
  );
  // The packet names keysets by 8 bytes; restore takes the mint's full id.
  const mapped = await fullKeysetIds(
    http,
    captured.outputs.map(o => o.id),
  );
  const restore = mapped.error
    ? undefined
    : await http('/v1/restore', {
        outputs: captured.outputs.map(o => ({...o, id: mapped.full[o.id]})),
      });
  const {crypto} = require(path.join(
    process.argv[2],
    'tools/assisted-relay/node-adapter.cjs',
  ));
  const states = await http('/v1/checkstate', {
    Ys: captured.inputs.map(i => crypto.proofY(i.secret)),
  });
  return {
    ...(restore
      ? {restored: restore.signatures.length}
      : {error: mapped.error}),
    inputs: states.states.map(s => s.state),
  };
}

main().catch(error => {
  process.stderr.write((error && error.stack) || String(error));
  process.stderr.write('\n');
  process.exitCode = 1;
});
