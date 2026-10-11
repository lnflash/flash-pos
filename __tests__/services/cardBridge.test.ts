import {Linking, LogBox} from 'react-native';
import {NfcError} from 'react-native-nfc-manager';

import {
  BRIDGE_TAG,
  CARD_BRIDGE_TIMEOUT_MS,
  bridgeTransceiver,
  getCardBridge,
  installCardBridgeDeepLinks,
  parseCardBridgeLink,
  setCardBridge,
} from '../../src/services/cardBridge';
import {describeCardFailure} from '../../src/services/cashuCardNfc';
import {
  hasLnurlwRecord,
  isIsoDepTag,
  mayCarryNdef,
} from '../../src/utils/nfcTag';

const URL_ = 'http://127.0.0.1:9876';

const SELECT = [0x00, 0xa4, 0x04, 0x00, 0x07, 0xd2, 0x76, 0x00, 0x00, 0x85];
const LOAD = [0x80, 0x30, 0x00, 0x00, 0x01, 0xaa];
const GET_INFO = [0x80, 0x10, 0x00, 0x00, 0x00];

type FetchReply = {ok: boolean; status: number; json: () => Promise<unknown>};
const reply = (body: unknown, status = 200): FetchReply => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => body,
});

const realFetch = global.fetch;
let fetchMock: jest.Mock;
const realDev = (global as {__DEV__?: boolean}).__DEV__;

beforeEach(() => {
  fetchMock = jest.fn(async () => reply({hex: '9000', sw: '9000'}));
  global.fetch = fetchMock as unknown as typeof fetch;
  setCardBridge(null);
});

afterEach(() => {
  global.fetch = realFetch;
  (global as {__DEV__?: boolean}).__DEV__ = realDev;
  setCardBridge(null);
  jest.useRealTimers();
  jest.restoreAllMocks();
});

describe('getCardBridge / setCardBridge', () => {
  it('is null until set, and a copy of the config once set', () => {
    expect(getCardBridge()).toBeNull();
    setCardBridge({url: URL_, dropLoad: 2});
    expect(getCardBridge()).toEqual({url: URL_, dropLoad: 2});
    // A copy: the caller cannot rewrite the live bridge.
    getCardBridge()!.url = 'http://evil.example';
    expect(getCardBridge()!.url).toBe(URL_);
  });

  it('is null in a release build whatever was set — no payment can leave the radio there', () => {
    setCardBridge({url: URL_});
    (global as {__DEV__?: boolean}).__DEV__ = false;
    expect(getCardBridge()).toBeNull();
    (global as {__DEV__?: boolean}).__DEV__ = true;
    expect(getCardBridge()).toEqual({url: URL_});
  });

  it('strips trailing slashes and surrounding space', () => {
    setCardBridge({url: ` ${URL_}// `});
    expect(getCardBridge()).toEqual({url: URL_});
  });

  it('clears with null', () => {
    setCardBridge({url: URL_});
    setCardBridge(null);
    expect(getCardBridge()).toBeNull();
  });

  it.each([
    '127.0.0.1:9876',
    'ftp://127.0.0.1',
    'http://',
    '',
    'mailto:card@example.com',
  ])('refuses %p and keeps the previous bridge', bad => {
    setCardBridge({url: URL_});
    expect(() => setCardBridge({url: bad})).toThrow(
      /card bridge: the URL must start with http:\/\/ or https:\/\//,
    );
    expect(getCardBridge()).toEqual({url: URL_});
  });

  it.each([0, -1, 1.5, NaN])('refuses dropLoad %p', bad => {
    expect(() => setCardBridge({url: URL_, dropLoad: bad})).toThrow(
      /dropLoad must be a positive integer/,
    );
    expect(getCardBridge()).toBeNull();
  });
});

describe('BRIDGE_TAG', () => {
  it('routes both multi-tech callers to the Cashu branch', () => {
    expect(isIsoDepTag(BRIDGE_TAG)).toBe(true);
    expect(mayCarryNdef(BRIDGE_TAG)).toBe(false);
    expect(hasLnurlwRecord(BRIDGE_TAG)).toBe(false);
  });
});

describe('bridgeTransceiver', () => {
  it('posts upper-case hex to /apdu and resolves the data and status word as bytes', async () => {
    fetchMock.mockResolvedValue(reply({hex: '0100ab9000', sw: '9000'}));
    const transceive = bridgeTransceiver({url: URL_});

    await expect(transceive(SELECT)).resolves.toEqual([
      0x01, 0x00, 0xab, 0x90, 0x00,
    ]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(`${URL_}/apdu`);
    expect(init.method).toBe('POST');
    expect(init.headers).toEqual({'Content-Type': 'application/json'});
    expect(JSON.parse(init.body)).toEqual({hex: '00A4040007D276000085'});
  });

  it('passes a card refusal through as data: the transport worked, the card said no', async () => {
    fetchMock.mockResolvedValue(reply({hex: '6A84', sw: '6A84'}));
    await expect(bridgeTransceiver({url: URL_})(LOAD)).resolves.toEqual([
      0x6a, 0x84,
    ]);
  });

  it('names a non-2xx answer', async () => {
    fetchMock.mockResolvedValue(reply({error: 'bad hex'}, 400));
    await expect(bridgeTransceiver({url: URL_})(SELECT)).rejects.toThrow(
      'card bridge: /apdu answered HTTP 400',
    );
  });

  it('names an answer that is not JSON', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => {
        throw new SyntaxError('Unexpected token <');
      },
    });
    await expect(bridgeTransceiver({url: URL_})(SELECT)).rejects.toThrow(
      'card bridge: /apdu answered something that is not JSON',
    );
  });

  it.each([
    ['no hex at all', {sw: '9000'}],
    ['an odd-length reply', {hex: '09000'}],
    ['non-hex characters', {hex: '90zz'}],
    ['a reply too short to hold a status word', {hex: '90'}],
    ['a non-string hex', {hex: 9000}],
    ['null', null],
  ])('refuses %s as malformed', async (_label, body) => {
    fetchMock.mockResolvedValue(reply(body));
    await expect(bridgeTransceiver({url: URL_})(SELECT)).rejects.toThrow(
      /^card bridge: malformed \/apdu reply/,
    );
  });

  it('names an unreachable bridge', async () => {
    fetchMock.mockRejectedValue(new TypeError('Network request failed'));
    await expect(bridgeTransceiver({url: URL_})(SELECT)).rejects.toThrow(
      `card bridge: ${URL_} is unreachable (Network request failed)`,
    );
  });

  it(`gives up after ${CARD_BRIDGE_TIMEOUT_MS} ms instead of hanging the charge`, async () => {
    jest.useFakeTimers();
    fetchMock.mockImplementation(
      (_url: string, init: {signal: AbortSignal}) =>
        new Promise((_resolve, reject) => {
          init.signal.addEventListener('abort', () =>
            reject(new Error('Aborted')),
          );
        }),
    );
    const pending = bridgeTransceiver({url: URL_})(SELECT);
    const settled = jest.fn();
    pending.catch(settled);

    jest.advanceTimersByTime(CARD_BRIDGE_TIMEOUT_MS - 1);
    await Promise.resolve();
    expect(settled).not.toHaveBeenCalled();

    jest.advanceTimersByTime(1);
    await expect(pending).rejects.toThrow(
      `card bridge: no answer from ${URL_} in ${CARD_BRIDGE_TIMEOUT_MS} ms`,
    );
  });

  it('shows its failures to the merchant verbatim', async () => {
    fetchMock.mockResolvedValue(reply({}, 500));
    const error = await bridgeTransceiver({url: URL_})(SELECT).catch(e => e);
    expect(describeCardFailure(error)).toBe(
      'card bridge: /apdu answered HTTP 500',
    );
  });

  describe('dropLoad fault injection', () => {
    it('forwards the n-th LOAD, drops its answer as a lost tag, once, and passes the next', async () => {
      setCardBridge({url: URL_, dropLoad: 2});
      const transceive = bridgeTransceiver(getCardBridge()!);

      // Other instructions are not counted.
      await expect(transceive(SELECT)).resolves.toEqual([0x90, 0x00]);
      await expect(transceive(GET_INFO)).resolves.toEqual([0x90, 0x00]);
      // LOAD #1 passes.
      await expect(transceive(LOAD)).resolves.toEqual([0x90, 0x00]);
      // LOAD #2 reaches the card, but the host hears a lost tag.
      const lost = await transceive(LOAD).catch(e => e);
      expect(lost).toBeInstanceOf(NfcError.TagConnectionLost);
      expect(describeCardFailure(lost)).toBe(
        'Card left the field — hold it still',
      );
      // LOAD #3 passes again.
      await expect(transceive(LOAD)).resolves.toEqual([0x90, 0x00]);

      const loadsSent = fetchMock.mock.calls.filter(
        ([, init]) => JSON.parse(init.body).hex.slice(2, 4) === '30',
      );
      expect(loadsSent).toHaveLength(3);
    });

    it('counts across sessions until the bridge is set again', async () => {
      setCardBridge({url: URL_, dropLoad: 2});
      await bridgeTransceiver(getCardBridge()!)(LOAD);
      await expect(
        bridgeTransceiver(getCardBridge()!)(LOAD),
      ).rejects.toBeInstanceOf(NfcError.TagConnectionLost);

      // Setting the bridge again restarts the count.
      setCardBridge({url: URL_, dropLoad: 2});
      await expect(bridgeTransceiver(getCardBridge()!)(LOAD)).resolves.toEqual([
        0x90, 0x00,
      ]);
      await expect(
        bridgeTransceiver(getCardBridge()!)(LOAD),
      ).rejects.toBeInstanceOf(NfcError.TagConnectionLost);
    });

    it('drops nothing without dropLoad', async () => {
      setCardBridge({url: URL_});
      const transceive = bridgeTransceiver(getCardBridge()!);
      for (let i = 0; i < 5; i++) {
        await expect(transceive(LOAD)).resolves.toEqual([0x90, 0x00]);
      }
    });
  });
});

describe('parseCardBridgeLink', () => {
  it.each([
    [
      'flashpos://dev/card-bridge?url=http://127.0.0.1:9876',
      {action: 'set', config: {url: URL_}},
    ],
    [
      'flashpos://dev/card-bridge?url=http%3A%2F%2F127.0.0.1%3A9876%2F',
      {action: 'set', config: {url: URL_}},
    ],
    [
      'flashpos://dev/card-bridge?url=http://127.0.0.1:9876&dropLoad=1',
      {action: 'set', config: {url: URL_, dropLoad: 1}},
    ],
    [
      'flashpos://dev/card-bridge?dropLoad=3&url=http://10.0.2.2:9876',
      {action: 'set', config: {url: 'http://10.0.2.2:9876', dropLoad: 3}},
    ],
    ['flashpos://dev/card-bridge?off=1', {action: 'clear'}],
    ['flashpos://dev/card-bridge/?off', {action: 'clear'}],
  ])('reads %s', (link, expected) => {
    expect(parseCardBridgeLink(link)).toEqual(expected);
  });

  it.each([
    'https://flashapp.me/dev/card-bridge?url=http://127.0.0.1:9876',
    'flashpos://dev/other?url=http://127.0.0.1:9876',
    'flashpos://dev/card-bridgex?url=http://127.0.0.1:9876',
    'flashpos://dev/card-bridge',
    'flashpos://dev/card-bridge?url=',
    'flashpos://dev/card-bridge?url=ftp://127.0.0.1',
    'flashpos://dev/card-bridge?url=http://127.0.0.1:9876&dropLoad=0',
    'flashpos://dev/card-bridge?url=http://127.0.0.1:9876&dropLoad=two',
    'flashpos://dev/card-bridge?url=%E0%A4%A',
  ])('ignores %s', link => {
    expect(parseCardBridgeLink(link)).toBeNull();
  });
});

describe('installCardBridgeDeepLinks', () => {
  function stubLinking(initial: string | null) {
    let handler: ((event: {url: string}) => void) | undefined;
    const remove = jest.fn();
    jest.spyOn(Linking, 'getInitialURL').mockResolvedValue(initial);
    const add = jest.spyOn(Linking, 'addEventListener').mockImplementation(((
      _type: string,
      h: typeof handler,
    ) => {
      handler = h;
      return {remove};
    }) as never);
    // The preset's Linking methods are already jest.fn()s; spyOn reuses
    // them, so their calls from earlier tests must not count here.
    add.mockClear();
    (Linking.getInitialURL as jest.Mock).mockClear();
    return {
      add,
      remove,
      open: (url: string) => handler!({url}),
    };
  }

  beforeEach(() => {
    jest.spyOn(console, 'log').mockImplementation(() => {});
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    jest.spyOn(LogBox, 'ignoreAllLogs').mockImplementation(() => {});
  });

  it('applies the link the app was launched with', async () => {
    stubLinking('flashpos://dev/card-bridge?url=http://127.0.0.1:9876');
    const cleanup = installCardBridgeDeepLinks();
    await new Promise(resolve => setImmediate(resolve));

    expect(getCardBridge()).toEqual({url: URL_});
    // Automation set it: no LogBox toast may cover what it taps.
    expect(LogBox.ignoreAllLogs).toHaveBeenCalledWith(true);
    cleanup();
  });

  it('applies links while running, clears on off=1, ignores the rest, and unsubscribes on cleanup', async () => {
    const linking = stubLinking(null);
    const cleanup = installCardBridgeDeepLinks();
    await new Promise(resolve => setImmediate(resolve));
    expect(getCardBridge()).toBeNull();

    linking.open(
      'flashpos://dev/card-bridge?url=http://127.0.0.1:9876&dropLoad=1',
    );
    expect(getCardBridge()).toEqual({url: URL_, dropLoad: 1});

    linking.open('https://flashapp.me/somewhere');
    expect(getCardBridge()).toEqual({url: URL_, dropLoad: 1});

    linking.open('flashpos://dev/card-bridge?url=nope');
    expect(getCardBridge()).toEqual({url: URL_, dropLoad: 1});
    expect(console.warn).toHaveBeenCalledWith(
      '[card-bridge] ignoring malformed link',
      'flashpos://dev/card-bridge?url=nope',
    );

    linking.open('flashpos://dev/card-bridge?off=1');
    expect(getCardBridge()).toBeNull();

    cleanup();
    expect(linking.remove).toHaveBeenCalledTimes(1);
  });

  it('listens to nothing in a release build', () => {
    const linking = stubLinking(
      'flashpos://dev/card-bridge?url=http://127.0.0.1:9876',
    );
    (global as {__DEV__?: boolean}).__DEV__ = false;

    const cleanup = installCardBridgeDeepLinks();

    expect(linking.add).not.toHaveBeenCalled();
    expect(Linking.getInitialURL).not.toHaveBeenCalled();
    expect(() => cleanup()).not.toThrow();
  });
});
