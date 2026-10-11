/**
 * The simulator's "card": every APDU goes to a cardsim bridge over HTTP
 * instead of the NFC radio (ENG-634).
 *
 * cardsim (lnflash/cashu-javacard, `tools/cardsim`) runs the real applet in
 * jCardSim and serves it on loopback: `POST /apdu {hex}` answers
 * `{hex, sw}`, the applet's data‖SW. The iOS simulator has no NFC, so this is
 * how the Maestro flows (`.maestro/flashcard/`) drive the production charge,
 * balance and owed-change paths end to end against a card that behaves like
 * the real one.
 *
 * Dev builds only. `getCardBridge()` answers `null` whenever `__DEV__` is
 * false, whatever was set, so a release build can never route a payment
 * anywhere but the radio. The state lives in this module and is never
 * persisted: a relaunch is back on NFC until the bridge is set again (deep
 * link `flashpos://dev/card-bridge?url=…`, or the CashuCardDebug screen).
 *
 * "Tap" is implicit: with the bridge set, a card session opens at once (see
 * `openCardSession` in cashuCardNfc.ts). There is no field to enter and no
 * sheet to dismiss, so the Android keypad's arm loop would spin in this mode;
 * the bridge is for the iOS simulator.
 */
import {Linking, LogBox} from 'react-native';
import {NfcError, type TagEvent} from 'react-native-nfc-manager';

import type {Transceiver} from './cashuCard';

export interface CardBridgeConfig {
  /** Base URL of the cardsim bridge, e.g. `http://127.0.0.1:9876`. */
  url: string;
  /**
   * Fault injection: the n-th LOAD_PROOF (1-based, counted since the bridge
   * was set) reaches the card, but its answer is dropped and the session
   * reports the tag lost, once. The transport twin of the jest harness's
   * `loseAnswerOnLoad` (`__tests__/services/cashuCharge.test.ts`).
   */
  dropLoad?: number;
}

/** A dead bridge fails the session; it must never leave a charge hanging. */
export const CARD_BRIDGE_TIMEOUT_MS = 5000;

/** Where the deep link lives: `flashpos://dev/card-bridge?url=…&dropLoad=…`. */
export const CARD_BRIDGE_LINK = 'flashpos://dev/card-bridge';

/** cashu-javacard's LOAD_PROOF instruction byte (`INS` in cashuCard.ts). */
const INS_LOAD_PROOF = 0x30;

/**
 * What a bridge "tap" reports: an ISO-DEP tag with no NDEF surface, so both
 * multi-tech callers (the keypad reader and the invoice router) take the
 * Cashu branch and never touch `ndefHandler` — `isIsoDepTag` true,
 * `mayCarryNdef` false, `hasLnurlwRecord` false (utils/nfcTag.ts).
 */
export const BRIDGE_TAG = {
  id: 'card-bridge',
  tech: 'IsoDep',
  techTypes: ['IsoDep'],
  ndefMessage: [],
} as TagEvent;

let bridge: CardBridgeConfig | null = null;
/** LOAD_PROOF APDUs sent since the bridge was set, for `dropLoad`. */
let loadsSent = 0;

/** The active bridge, or `null` on NFC. Always `null` outside dev builds. */
export function getCardBridge(): CardBridgeConfig | null {
  if (!__DEV__) {
    return null;
  }
  return bridge ? {...bridge} : null;
}

/**
 * Routes every card APDU to `config.url` (or back to NFC with `null`).
 * Throws on a URL that is not http(s) or a `dropLoad` that is not a positive
 * integer, leaving the previous setting in place. Setting resets the fault
 * counter, so `dropLoad` counts from this call.
 */
export function setCardBridge(config: CardBridgeConfig | null): void {
  if (config === null) {
    bridge = null;
    loadsSent = 0;
    return;
  }
  const url = config.url.trim();
  if (!/^https?:\/\/[^\s/]+/i.test(url)) {
    throw new Error(
      `card bridge: the URL must start with http:// or https://, got "${config.url}"`,
    );
  }
  const {dropLoad} = config;
  if (dropLoad !== undefined && !(Number.isInteger(dropLoad) && dropLoad > 0)) {
    throw new Error(
      `card bridge: dropLoad must be a positive integer, got ${dropLoad}`,
    );
  }
  bridge = {url: url.replace(/\/+$/, ''), ...(dropLoad ? {dropLoad} : {})};
  loadsSent = 0;
}

const toHex = (bytes: number[]): string =>
  bytes
    .map(b => b.toString(16).padStart(2, '0'))
    .join('')
    .toUpperCase();

function fromHex(hex: string): number[] {
  const bytes: number[] = [];
  for (let i = 0; i < hex.length; i += 2) {
    bytes.push(parseInt(hex.slice(i, i + 2), 16));
  }
  return bytes;
}

/** One APDU to the bridge and back. Never retried: a replayed LOAD burns a slot. */
async function postApdu(url: string, hex: string): Promise<number[]> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), CARD_BRIDGE_TIMEOUT_MS);
  let response: Response;
  try {
    response = await fetch(`${url}/apdu`, {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({hex}),
      signal: controller.signal,
    });
  } catch (error) {
    if (controller.signal.aborted) {
      throw new Error(
        `card bridge: no answer from ${url} in ${CARD_BRIDGE_TIMEOUT_MS} ms`,
      );
    }
    throw new Error(
      `card bridge: ${url} is unreachable (${
        error instanceof Error ? error.message : String(error)
      })`,
    );
  } finally {
    clearTimeout(timer);
  }
  if (!response.ok) {
    throw new Error(`card bridge: /apdu answered HTTP ${response.status}`);
  }
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw new Error('card bridge: /apdu answered something that is not JSON');
  }
  const replyHex = (body as {hex?: unknown} | null)?.hex;
  if (
    typeof replyHex !== 'string' ||
    replyHex.length < 4 ||
    replyHex.length % 2 !== 0 ||
    !/^[0-9a-f]+$/i.test(replyHex)
  ) {
    throw new Error(
      `card bridge: malformed /apdu reply ${JSON.stringify(body)}`,
    );
  }
  return fromHex(replyHex);
}

/** A tag that left the field, as the NFC stack reports one. */
function tagLost(): Error {
  const Lost = (NfcError as Partial<typeof NfcError> | undefined)
    ?.TagConnectionLost;
  return Lost ? new Lost() : new Error('card bridge: tag was lost');
}

/**
 * The bridge as a `Transceiver`: upper-case hex out, data‖SW back, the same
 * array `nfcTransceiver` resolves. Transport failures throw an Error whose
 * message starts `card bridge:`, which `describeCardFailure` shows as is.
 */
export function bridgeTransceiver(config: CardBridgeConfig): Transceiver {
  return async (apdu: number[]) => {
    let drop = false;
    if (apdu[1] === INS_LOAD_PROOF) {
      loadsSent += 1;
      drop = config.dropLoad === loadsSent;
    }
    const reply = await postApdu(config.url, toHex(apdu));
    if (drop) {
      // The card wrote the slot; the host never hears it did.
      throw tagLost();
    }
    return reply;
  };
}

export type CardBridgeLink =
  | {action: 'set'; config: CardBridgeConfig}
  | {action: 'clear'};

/**
 * Reads `flashpos://dev/card-bridge?url=<bridge>[&dropLoad=<n>]` or
 * `…?off=1`. Anything else — another link, a missing or non-http URL, a
 * `dropLoad` that is not a positive integer — answers `null`. The URL may
 * arrive percent-encoded or raw (`url=http://127.0.0.1:9876`).
 */
export function parseCardBridgeLink(link: string): CardBridgeLink | null {
  if (!link.startsWith(CARD_BRIDGE_LINK)) {
    return null;
  }
  const rest = link.slice(CARD_BRIDGE_LINK.length);
  if (rest !== '' && !rest.startsWith('?') && !rest.startsWith('/?')) {
    return null;
  }
  const query = rest.slice(rest.indexOf('?') + 1);
  const params = new Map<string, string>();
  for (const part of query.split('&')) {
    if (!part) {
      continue;
    }
    const eq = part.indexOf('=');
    const key = eq === -1 ? part : part.slice(0, eq);
    const raw = eq === -1 ? '' : part.slice(eq + 1);
    try {
      params.set(key, decodeURIComponent(raw.replace(/\+/g, ' ')));
    } catch {
      return null;
    }
  }
  if (params.has('off')) {
    return {action: 'clear'};
  }
  const url = params.get('url');
  if (!url || !/^https?:\/\/[^\s/]+/i.test(url)) {
    return null;
  }
  const config: CardBridgeConfig = {url: url.replace(/\/+$/, '')};
  const dropLoadRaw = params.get('dropLoad');
  if (dropLoadRaw !== undefined) {
    const dropLoad = Number(dropLoadRaw);
    if (!(Number.isInteger(dropLoad) && dropLoad > 0)) {
      return null;
    }
    config.dropLoad = dropLoad;
  }
  return {action: 'set', config};
}

/** Applies one incoming link; ignores every link that is not ours. */
function applyCardBridgeLink(link: string | null | undefined): void {
  if (!link) {
    return;
  }
  const parsed = parseCardBridgeLink(link);
  if (!parsed) {
    if (link.startsWith(CARD_BRIDGE_LINK)) {
      console.warn('[card-bridge] ignoring malformed link', link);
    }
    return;
  }
  if (parsed.action === 'clear') {
    setCardBridge(null);
    console.log('[card-bridge] off: card sessions use NFC');
    return;
  }
  setCardBridge(parsed.config);
  // The link is how automation (Maestro) sets the bridge; a LogBox toast
  // from an unrelated dev warning would sit over the keypad it taps.
  LogBox.ignoreAllLogs(true);
  console.log(
    `[card-bridge] on: card sessions use ${parsed.config.url}` +
      (parsed.config.dropLoad
        ? ` (dropping the answer to LOAD #${parsed.config.dropLoad})`
        : ''),
  );
}

/**
 * Listens for the card-bridge deep link (cold start and while running).
 * Dev builds only; answers the cleanup for a `useEffect`.
 */
export function installCardBridgeDeepLinks(): () => void {
  if (!__DEV__) {
    return () => {};
  }
  Linking.getInitialURL()
    .then(applyCardBridgeLink)
    .catch(() => {});
  const subscription = Linking.addEventListener('url', ({url}) =>
    applyCardBridgeLink(url),
  );
  return () => subscription.remove();
}
