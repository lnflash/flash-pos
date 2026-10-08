import {TagEvent} from 'react-native-nfc-manager';

import {
  getLnurlwPayload,
  hasLnurlwRecord,
  isIsoDepTag,
  mayCarryNdef,
} from '../../src/utils/nfcTag';

// The real text decoder: the helper must read the bytes exactly the way the
// Flashcard context does, or the router would hand it a tag it then ignores.
jest.mock('react-native-nfc-manager', () => ({
  __esModule: true,
  default: {},
  Ndef: {
    text: jest.requireActual('react-native-nfc-manager/ndef-lib/ndef-text'),
  },
}));

const LNURLW = 'lnurlw://btcpay.flashapp.me/boltcard?p=0A1B&c=2C3D';
const bytes = (text: string) => Array.from(Buffer.from(text, 'utf8'));
const uriRecord = (uri: string) => ({
  tnf: 1 as const,
  type: 'U',
  payload: [0x00, ...bytes(uri)],
});
const textRecord = (text: string) => ({
  tnf: 1 as const,
  type: 'T',
  payload: [0x02, ...bytes('en'), ...bytes(text)],
});

const tag = (fields: Partial<TagEvent> & {tech?: string}): TagEvent =>
  fields as TagEvent;

describe('isIsoDepTag', () => {
  it('reads the iOS shape (tech: IsoDep)', () => {
    expect(isIsoDepTag(tag({tech: 'IsoDep'}))).toBe(true);
    expect(isIsoDepTag(tag({tech: 'MiFare'}))).toBe(false);
  });

  it('reads the Android shape (fully-qualified techTypes)', () => {
    expect(
      isIsoDepTag(
        tag({techTypes: ['android.nfc.tech.IsoDep', 'android.nfc.tech.NfcA']}),
      ),
    ).toBe(true);
    expect(isIsoDepTag(tag({techTypes: ['IsoDep']}))).toBe(true);
    expect(
      isIsoDepTag(
        tag({techTypes: ['android.nfc.tech.Ndef', 'android.nfc.tech.NfcA']}),
      ),
    ).toBe(false);
    expect(isIsoDepTag(tag({}))).toBe(false);
  });
});

describe('getLnurlwPayload / hasLnurlwRecord', () => {
  it('finds a BoltCard URI record (ENG-614)', () => {
    const v1 = tag({
      id: '04A1',
      techTypes: [
        'android.nfc.tech.IsoDep',
        'android.nfc.tech.NfcA',
        'android.nfc.tech.Ndef',
      ],
      ndefMessage: [uriRecord(LNURLW)],
    });
    expect(getLnurlwPayload(v1)).toBe(LNURLW);
    expect(hasLnurlwRecord(v1)).toBe(true);
  });

  it('finds it on the iOS shape too — tech is not what decides', () => {
    const v1 = tag({tech: 'IsoDep', ndefMessage: [uriRecord(LNURLW)]});
    expect(hasLnurlwRecord(v1)).toBe(true);
  });

  it('looks past a leading non-lnurlw record', () => {
    const multi = tag({
      ndefMessage: [textRecord('hello'), uriRecord(LNURLW)],
    });
    expect(getLnurlwPayload(multi)).toBe(LNURLW);
  });

  it('is not fooled by other records, empty messages or missing tags', () => {
    expect(hasLnurlwRecord(tag({ndefMessage: [textRecord('hello')]}))).toBe(
      false,
    );
    expect(
      hasLnurlwRecord(tag({ndefMessage: [uriRecord('https://getflash.io')]})),
    ).toBe(false);
    expect(hasLnurlwRecord(tag({ndefMessage: []}))).toBe(false);
    expect(hasLnurlwRecord(tag({tech: 'IsoDep'}))).toBe(false);
    expect(hasLnurlwRecord(null)).toBe(false);
    expect(hasLnurlwRecord(undefined)).toBe(false);
  });

  it('survives a record without a payload', () => {
    const broken = tag({
      ndefMessage: [{tnf: 1, type: 'U'} as unknown as TagEvent['ndefMessage'][0]],
    });
    expect(hasLnurlwRecord(broken)).toBe(false);
  });
});

describe('mayCarryNdef', () => {
  it('is true on iOS, where no tech types are reported', () => {
    expect(mayCarryNdef(tag({tech: 'IsoDep'}))).toBe(true);
    expect(mayCarryNdef(tag({techTypes: []}))).toBe(true);
  });

  it('follows Android tech types', () => {
    expect(
      mayCarryNdef(
        tag({techTypes: ['android.nfc.tech.IsoDep', 'android.nfc.tech.Ndef']}),
      ),
    ).toBe(true);
    expect(
      mayCarryNdef(
        tag({techTypes: ['android.nfc.tech.IsoDep', 'android.nfc.tech.NfcA']}),
      ),
    ).toBe(false);
  });
});
