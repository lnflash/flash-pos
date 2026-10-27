/** Atomic inventory and retirement history for merchant ecash. */
import {sha256} from '@noble/hashes/sha256';
import {bytesToHex, utf8ToBytes} from '@noble/hashes/utils';
import {getSecureStrict, setSecure} from './secureStorage';
import type {SettledProof} from './cashuMint';

const KEY = '@cashu_settled_proofs';
type Ledger = {
  version: 1;
  available: SettledProof[];
  retired: {id: string; reason: 'paid' | 'unknown'}[];
};
let writer: Promise<unknown> = Promise.resolve();

function serial<T>(operation: () => Promise<T>): Promise<T> {
  const result = writer.then(operation);
  writer = result.catch(() => undefined);
  return result;
}

function identity(
  p: Pick<SettledProof, 'secret' | 'mintUrl'>,
  legacy = false,
): string {
  return bytesToHex(
    sha256(
      utf8ToBytes(
        JSON.stringify([
          legacy ? '' : (p.mintUrl ?? '').replace(/\/$/, ''),
          p.secret,
        ]),
      ),
    ),
  );
}
function proof(value: unknown): value is SettledProof {
  if (!value || typeof value !== 'object') {
    return false;
  }
  const p = value as SettledProof;
  return (
    typeof p.id === 'string' &&
    p.id.length > 0 &&
    Number.isSafeInteger(p.amount) &&
    p.amount > 0 &&
    typeof p.secret === 'string' &&
    p.secret.length > 0 &&
    typeof p.C === 'string' &&
    p.C.length > 0 &&
    (p.mintUrl === undefined || typeof p.mintUrl === 'string')
  );
}
function sameMoney(a: SettledProof, b: SettledProof): boolean {
  return a.id === b.id && a.amount === b.amount && a.C === b.C;
}
function insert(available: SettledProof[], p: SettledProof): void {
  const prior = available.find(
    q =>
      identity(q) === identity(p) ||
      ((!q.mintUrl || !p.mintUrl) && identity(q, true) === identity(p, true)),
  );
  if (prior) {
    if (!sameMoney(prior, p)) {
      throw new Error('conflicting merchant proof identity');
    }
    // Associate a legacy proof with its verified mint during recovery.
    if (!prior.mintUrl && p.mintUrl) {
      prior.mintUrl = p.mintUrl;
    }
    return;
  }
  available.push({...p});
}
async function read(): Promise<Ledger> {
  const raw = await getSecureStrict(KEY);
  if (!raw) {
    return {version: 1, available: [], retired: []};
  }
  const parsed: unknown = JSON.parse(raw);
  const ledger = Array.isArray(parsed)
    ? {version: 1, available: parsed, retired: []}
    : (parsed as Ledger);
  if (
    !ledger ||
    ledger.version !== 1 ||
    !Array.isArray(ledger.available) ||
    !ledger.available.every(proof) ||
    !Array.isArray(ledger.retired) ||
    !ledger.retired.every(
      item =>
        item &&
        /^[a-f0-9]{64}$/.test(item.id) &&
        (item.reason === 'paid' || item.reason === 'unknown'),
    )
  ) {
    throw new Error('invalid merchant inventory; preserve for reconciliation');
  }
  const available: SettledProof[] = [];
  const retired = new Map(ledger.retired.map(item => [item.id, item.reason]));
  for (const p of ledger.available) {
    if (retired.has(identity(p)) || retired.has(identity(p, true))) {
      throw new Error('merchant proof is both available and retired');
    }
    insert(available, p);
  }
  return {
    version: 1,
    available,
    retired: [...retired].map(([id, reason]) => ({id, reason})),
  };
}

export function readTill(): Promise<SettledProof[]> {
  return serial(async () => (await read()).available);
}

/** One secure-store replacement commits both removal and its replay fence. */
export function updateTill({
  add = [],
  retire = [],
  disposition = 'unknown',
}: {
  add?: SettledProof[];
  retire?: SettledProof[];
  disposition?: 'paid' | 'unknown';
}): Promise<void> {
  return serial(async () => {
    if (![...add, ...retire].every(proof)) {
      throw new Error('invalid merchant proof');
    }
    const ledger = await read();
    const retired = new Map(ledger.retired.map(item => [item.id, item.reason]));
    for (const p of retire) {
      retired.set(
        identity(p),
        retired.get(identity(p)) === 'paid' ? 'paid' : disposition,
      );
      // Fence a missing-mint identity only when that legacy entry existed.
      for (const q of ledger.available) {
        if (!q.mintUrl && identity(q, true) === identity(p, true)) {
          retired.set(
            identity(q),
            retired.get(identity(q)) === 'paid' ? 'paid' : disposition,
          );
        }
      }
    }
    ledger.available = ledger.available.filter(
      p => !retired.has(identity(p)) && !retired.has(identity(p, true)),
    );
    for (const p of add) {
      if (!retired.has(identity(p)) && !retired.has(identity(p, true))) {
        insert(ledger.available, p);
      }
    }
    ledger.retired = [...retired].map(([id, reason]) => ({id, reason}));
    await setSecure(KEY, JSON.stringify(ledger));
  });
}

/** Only a recorded successful payout can account for already-consumed outputs. */
export function recordedPayout(proofs: SettledProof[]): Promise<boolean> {
  return serial(async () => {
    const ledger = await read();
    const retired = new Map(ledger.retired.map(item => [item.id, item.reason]));
    return proofs.every(
      p =>
        retired.get(identity(p)) === 'paid' ||
        retired.get(identity(p, true)) === 'paid',
    );
  });
}

/** New payments must use secrets absent from both live and retired inventory. */
export function assertFreshTillSecrets(
  proofs: Pick<SettledProof, 'secret' | 'mintUrl'>[],
): Promise<void> {
  return serial(async () => {
    const ledger = await read();
    const retired = new Set(ledger.retired.map(item => item.id));
    const seen = new Set<string>();
    for (const p of proofs) {
      const id = identity(p);
      if (
        seen.has(id) ||
        retired.has(id) ||
        retired.has(identity(p, true)) ||
        ledger.available.some(
          q =>
            identity(q) === id ||
            (!q.mintUrl && identity(q, true) === identity(p, true)),
        )
      ) {
        throw new Error('merchant output secret has already been used');
      }
      seen.add(id);
    }
  });
}
