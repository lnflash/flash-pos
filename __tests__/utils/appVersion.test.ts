import {APP_VERSION} from '../../src/utils/appVersion';
import pkg from '../../package.json';

describe('APP_VERSION', () => {
  it('is the package.json version, not a literal that can drift', () => {
    expect(APP_VERSION).toBe(pkg.version);
    expect(APP_VERSION).not.toBe('0.3.1');
  });

  it('looks like a release version', () => {
    expect(APP_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
  });
});
