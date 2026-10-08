import {Ndef, NdefRecord, TagEvent} from 'react-native-nfc-manager';

/**
 * The tag payload shape differs per platform:
 *   - iOS reports `tech: 'IsoDep'` for ISO7816 tags (NfcManager.m
 *     getRNTechName) and no `techTypes`;
 *   - Android reports `techTypes` with fully-qualified class names
 *     ('android.nfc.tech.IsoDep').
 */
type TagWithTech = TagEvent & {tech?: string};

export const isIsoDepTag = (tag: TagEvent): boolean => {
  if ((tag as TagWithTech).tech === 'IsoDep') {
    return true;
  }
  return (tag.techTypes ?? []).some(
    tech => tech === 'IsoDep' || tech === 'android.nfc.tech.IsoDep',
  );
};

/**
 * True when the platform says the tag may have an NDEF surface worth reading:
 * iOS never lists tech types (its ISO7816 handle is also an NDEF handle), and
 * Android lists `android.nfc.tech.Ndef` when it found one.
 */
export const mayCarryNdef = (tag: TagEvent): boolean => {
  const techs = tag.techTypes;
  if (!techs || techs.length === 0) {
    return true;
  }
  return techs.some(
    tech => tech === 'Ndef' || tech === 'android.nfc.tech.Ndef',
  );
};

const decodeRecord = (record: NdefRecord | undefined): string | undefined => {
  if (!record?.payload) {
    return undefined;
  }
  try {
    // Same decoder the Flashcard context uses on this record: a BoltCard's
    // URI record carries a 0x00 prefix byte, which the text decoder reads
    // as "no language code" and skips, leaving the bare lnurlw URL.
    return Ndef.text.decodePayload(new Uint8Array(record.payload));
  } catch {
    return undefined;
  }
};

/**
 * The lnurlw withdraw URL carried by a BoltCard-style tag, or undefined.
 *
 * Tech is not evidence of what a card is: a Flashcard v1 is a BoltCard on an
 * NTAG 424 DNA, which answers an IsoDep request just like a Cashu javacard
 * does. The NDEF record is the evidence — a tag that carries an `lnurlw`
 * record is a BoltCard whatever else it can do (ENG-614).
 */
export const getLnurlwPayload = (
  tag: TagEvent | null | undefined,
): string | undefined => {
  for (const record of tag?.ndefMessage ?? []) {
    const payload = decodeRecord(record);
    if (payload?.startsWith('lnurlw')) {
      return payload;
    }
  }
  return undefined;
};

/** True when the tag carries an NDEF record whose payload starts with `lnurlw`. */
export const hasLnurlwRecord = (tag: TagEvent | null | undefined): boolean =>
  getLnurlwPayload(tag) !== undefined;
