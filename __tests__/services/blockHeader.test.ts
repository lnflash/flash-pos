/**
 * blockHeader — where a till takes the Bitcoin tip header it shows a 2.0
 * card (SET_HEADER, the card's clock): mempool.space first, blockstream.info
 * as the fallback, a dev-only override for the e2e stub, cached for 10
 * minutes, and never fetched inside an NFC session.
 */
import {
  DEFAULT_HEADER_APIS,
  TIP_TTL_MS,
  __resetTipHeader,
  blockHash,
  cachedTipHeader,
  fetchTipHeader,
  headerApis,
  refreshTipHeader,
  setHeaderApisOverride,
} from '../../src/services/blockHeader';
import {headerVectors} from '../support/cardProtocol2';

const [older, tip] = [headerVectors()[10], headerVectors()[11]];

/** An Esplora API double serving `served` as its tip. */
function esplora(served: {hash: string; header: string}, base: string) {
  return jest.fn(async (url: string) => {
    if (url === `${base}/blocks/tip/hash`) {
      return {ok: true, status: 200, text: async () => `${served.hash}\n`};
    }
    if (url === `${base}/block/${served.hash}/header`) {
      return {ok: true, status: 200, text: async () => served.header};
    }
    return {ok: false, status: 404, text: async () => 'not found'};
  });
}

beforeEach(() => {
  __resetTipHeader();
});

describe('blockHash', () => {
  it('is the double SHA-256 of the header, as Bitcoin shows a block hash', () => {
    for (const v of headerVectors()) {
      expect(blockHash(Array.from(Buffer.from(v.header, 'hex')))).toBe(v.hash);
    }
  });
});

describe('headerApis', () => {
  it('mempool.space first, blockstream.info as the fallback (decision 7)', () => {
    expect(headerApis()).toEqual([
      'https://mempool.space/api',
      'https://blockstream.info/api',
    ]);
    expect(DEFAULT_HEADER_APIS).toEqual(headerApis());
  });

  it('a dev build takes an override (the e2e stub), and drops it with null', () => {
    setHeaderApisOverride(['http://127.0.0.1:9877/', 'not a url']);
    expect(headerApis()).toEqual(['http://127.0.0.1:9877']);
    setHeaderApisOverride(null);
    expect(headerApis()).toEqual(DEFAULT_HEADER_APIS);
  });
});

describe('fetchTipHeader', () => {
  it('takes the tip hash, then its header, and checks one against the other', async () => {
    const fetchFn = esplora(tip, 'https://a.example/api');
    await expect(
      fetchTipHeader({apis: ['https://a.example/api'], fetchFn}),
    ).resolves.toEqual(Array.from(Buffer.from(tip.header, 'hex')));
    expect(fetchFn.mock.calls.map(c => c[0])).toEqual([
      'https://a.example/api/blocks/tip/hash',
      `https://a.example/api/block/${tip.hash}/header`,
    ]);
  });

  it('falls back to the next source when the first fails', async () => {
    const down = jest.fn(async () => {
      throw new TypeError('Network request failed');
    });
    const second = esplora(tip, 'https://b.example/api');
    const fetchFn = jest.fn(async (url: string) =>
      url.startsWith('https://a.example') ? down() : second(url),
    );
    await expect(
      fetchTipHeader({
        apis: ['https://a.example/api', 'https://b.example/api'],
        fetchFn,
      }),
    ).resolves.toHaveLength(80);
  });

  it('refuses a header that does not hash to the hash the source named', async () => {
    const lying = esplora(
      {hash: tip.hash, header: older.header},
      'https://a.example/api',
    );
    await expect(
      fetchTipHeader({apis: ['https://a.example/api'], fetchFn: lying}),
    ).resolves.toBeNull();
  });

  it('refuses answers that are not a hash or a header', async () => {
    const junk = jest.fn(async () => ({
      ok: true,
      status: 200,
      text: async () => '<html>',
    }));
    await expect(
      fetchTipHeader({apis: ['https://a.example/api'], fetchFn: junk}),
    ).resolves.toBeNull();
  });

  it('null when every source fails: the card keeps its clock', async () => {
    const down = jest.fn(async () => ({
      ok: false,
      status: 503,
      text: async () => '',
    }));
    await expect(
      fetchTipHeader({apis: DEFAULT_HEADER_APIS, fetchFn: down}),
    ).resolves.toBeNull();
    expect(down).toHaveBeenCalledTimes(2);
  });
});

describe('the cached tip', () => {
  it('is fetched once and kept for 10 minutes', async () => {
    let now = 1_000_000;
    const fetchFn = esplora(tip, DEFAULT_HEADER_APIS[0]);
    const first = await refreshTipHeader({fetchFn, now: () => now});
    expect(first).toHaveLength(80);
    expect(cachedTipHeader(now)).toEqual(first);

    now += TIP_TTL_MS - 1;
    await refreshTipHeader({fetchFn, now: () => now});
    expect(fetchFn).toHaveBeenCalledTimes(2);
    expect(cachedTipHeader(now)).toEqual(first);

    now += 1;
    expect(cachedTipHeader(now)).toBeNull();
    await refreshTipHeader({fetchFn, now: () => now});
    expect(fetchFn).toHaveBeenCalledTimes(4);
  });

  it('a refresh never rejects, and a failed one keeps nothing', async () => {
    const down = jest.fn(async () => {
      throw new TypeError('offline');
    });
    await expect(
      refreshTipHeader({fetchFn: down as never, now: () => 5}),
    ).resolves.toBeNull();
    expect(cachedTipHeader(5)).toBeNull();
  });

  it('concurrent refreshes share one fetch', async () => {
    const fetchFn = esplora(tip, DEFAULT_HEADER_APIS[0]);
    const [a, b] = await Promise.all([
      refreshTipHeader({fetchFn, now: () => 10}),
      refreshTipHeader({fetchFn, now: () => 10}),
    ]);
    expect(a).toEqual(b);
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });

  it('an override drops the tip the defaults gave', async () => {
    const fetchFn = esplora(tip, DEFAULT_HEADER_APIS[0]);
    await refreshTipHeader({fetchFn, now: () => 10});
    setHeaderApisOverride(['http://127.0.0.1:9877']);
    expect(cachedTipHeader(10)).toBeNull();
  });
});
