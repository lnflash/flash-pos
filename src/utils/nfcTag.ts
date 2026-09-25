import {TagEvent} from 'react-native-nfc-manager';

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
