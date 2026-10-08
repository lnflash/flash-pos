/**
 * Flashcard context — handleTag reads the tag with the same decoder the card
 * payment router routes by (getLnurlwPayload), so a tag the router sent here
 * as a BoltCard is handled as one whatever record comes first (ENG-614).
 */
import React, {useContext} from 'react';
import {TagEvent} from 'react-native-nfc-manager';
import {act, render} from '@testing-library/react-native';
import {getParams} from 'js-lnurl';

import {
  FlashcardContext,
  FlashcardProvider,
} from '../../src/contexts/Flashcard';
import {toastShow} from '../../src/utils/toast';

const mockScreen = {name: 'Invoice'};

jest.mock('react-native-nfc-manager', () => ({
  __esModule: true,
  default: {
    isSupported: jest.fn(() => Promise.resolve(true)),
    isEnabled: jest.fn(() => Promise.resolve(true)),
    setEventListener: jest.fn(),
    registerTagEvent: jest.fn(),
    unregisterTagEvent: jest.fn(),
    cancelTechnologyRequest: jest.fn(),
  },
  // The real decoder: the whole point is that this context and the router
  // read the same bytes the same way.
  Ndef: {
    text: jest.requireActual('react-native-nfc-manager/ndef-lib/ndef-text'),
  },
  NfcEvents: {DiscoverTag: 'DiscoverTag', SessionClosed: 'SessionClosed'},
  NfcTech: {Ndef: 'Ndef', IsoDep: 'IsoDep'},
}));

jest.mock('../../src/routes', () => ({
  navigationRef: {getCurrentRoute: () => mockScreen},
}));

jest.mock('../../src/utils/toast', () => ({toastShow: jest.fn()}));

jest.mock('js-lnurl', () => ({getParams: jest.fn()}));

jest.mock('axios', () => ({__esModule: true, default: {get: jest.fn()}}));

jest.mock('../../src/services/flashcardStorage', () => ({
  clearStoredFlashcards: jest.fn(async () => true),
  deleteStoredFlashcard: jest.fn(async () => true),
  getAllStoredFlashcards: jest.fn(async () => []),
  getStoredFlashcard: jest.fn(async () => null),
  storeFlashcardInfo: jest.fn(async () => {}),
}));

jest.mock('../../src/contexts/ActivityIndicator', () => ({
  ActivityIndicator: () => null,
}));

const mockGetParams = getParams as jest.MockedFunction<typeof getParams>;
const mockToastShow = toastShow as jest.MockedFunction<typeof toastShow>;

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
  ({id: '04A1B2C3D4E5F6', ...fields} as TagEvent);

/** Renders the provider and hands back its handleTag. */
function mountContext() {
  let handleTag: ((t: TagEvent) => void) | undefined;
  const Probe = () => {
    handleTag = useContext(FlashcardContext).handleTag;
    return null;
  };
  render(
    <FlashcardProvider>
      <Probe />
    </FlashcardProvider>,
  );
  return (t: TagEvent) => act(async () => handleTag!(t));
}

beforeEach(() => {
  jest.clearAllMocks();
  mockScreen.name = 'Invoice';
  mockGetParams.mockResolvedValue({
    tag: 'withdrawRequest',
    k1: 'k1',
    callback: 'https://btcpay.flashapp.me/cb',
  } as never);
});

describe('FlashcardProvider.handleTag', () => {
  it('handles a BoltCard whose lnurlw record comes first', async () => {
    const handle = mountContext();

    await handle(tag({ndefMessage: [uriRecord(LNURLW)]}));

    expect(mockGetParams).toHaveBeenCalledWith(LNURLW);
  });

  it('handles a BoltCard whose lnurlw record is not the first one (ENG-614)', async () => {
    // The router routes this tag here because getLnurlwPayload finds the
    // record; reading only ndefMessage[0] would see "hello" and drop it.
    const handle = mountContext();

    await handle(tag({ndefMessage: [textRecord('hello'), uriRecord(LNURLW)]}));

    expect(mockGetParams).toHaveBeenCalledWith(LNURLW);
    expect(mockToastShow).not.toHaveBeenCalledWith(
      expect.objectContaining({type: 'error'}),
    );
  });

  it('a tag with records but no lnurlw is neither paid nor reported missing', async () => {
    const handle = mountContext();

    await handle(tag({ndefMessage: [textRecord('hello')]}));

    expect(mockGetParams).not.toHaveBeenCalled();
    expect(mockToastShow).not.toHaveBeenCalledWith(
      expect.objectContaining({message: 'NDEF message not found.'}),
    );
  });

  it('a non-IsoDep tag with no NDEF message reports it', async () => {
    const handle = mountContext();

    await handle(tag({ndefMessage: []}));

    expect(mockToastShow).toHaveBeenCalledWith({
      message: 'NDEF message not found.',
      type: 'error',
    });
    expect(mockGetParams).not.toHaveBeenCalled();
  });

  it('an IsoDep tag with no NDEF surface is left to the card payment router', async () => {
    const handle = mountContext();

    await handle(tag({tech: 'IsoDep'}));

    expect(mockToastShow).not.toHaveBeenCalledWith(
      expect.objectContaining({message: 'NDEF message not found.'}),
    );
    expect(mockGetParams).not.toHaveBeenCalled();
  });

  it('off the payment screens, an lnurlw tag gets the info toast, not a payment', async () => {
    mockScreen.name = 'Settings';
    const handle = mountContext();

    await handle(tag({ndefMessage: [uriRecord(LNURLW)]}));

    expect(mockGetParams).not.toHaveBeenCalled();
    expect(mockToastShow).toHaveBeenCalledWith(
      expect.objectContaining({type: 'info'}),
    );
  });
});
