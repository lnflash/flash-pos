import * as Keychain from 'react-native-keychain';

export async function setSecure(key: string, value: string): Promise<void> {
  await Keychain.setGenericPassword(key, value, {service: key});
}

/**
 * Read a value, distinguishing "absent" from "could not read".
 *
 * Resolves to `null` only when the Keychain genuinely holds nothing for `key`.
 * A Keychain failure — device locked, entitlement missing, hardware error —
 * rejects. Callers that hold money (see `cashuSettlement.ts`) must be able to
 * tell those two apart: treating a failed read as an empty store is how an
 * outstanding-payment queue gets silently overwritten.
 */
export async function getSecureStrict(key: string): Promise<string | null> {
  const creds = await Keychain.getGenericPassword({service: key});
  return creds ? creds.password : null;
}

/**
 * Lenient read: a Keychain failure is flattened to `null`.
 *
 * Fine for caches and preferences. **Not** fine anywhere absence and failure
 * imply different actions — use `getSecureStrict` there.
 */
export async function getSecure(key: string): Promise<string | null> {
  try {
    return await getSecureStrict(key);
  } catch {
    return null;
  }
}

export async function removeSecure(key: string): Promise<void> {
  await Keychain.resetGenericPassword({service: key});
}
