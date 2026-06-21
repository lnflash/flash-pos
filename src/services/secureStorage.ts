import * as Keychain from 'react-native-keychain';

export async function setSecure(key: string, value: string): Promise<void> {
  await Keychain.setGenericPassword(key, value, {service: key});
}

export async function getSecure(key: string): Promise<string | null> {
  try {
    const creds = await Keychain.getGenericPassword({service: key});
    if (creds) {
      return creds.password;
    }
    return null;
  } catch {
    return null;
  }
}

export async function removeSecure(key: string): Promise<void> {
  await Keychain.resetGenericPassword({service: key});
}
