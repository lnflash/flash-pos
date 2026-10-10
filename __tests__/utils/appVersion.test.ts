import {APP_VERSION} from '../../src/utils/appVersion';
import pkg from '../../package.json';

describe('APP_VERSION', () => {
  it('is the package.json version, not a literal that can drift', () => {
    expect(APP_VERSION).toBe(pkg.version);
  });

  it('looks like a release version', () => {
    expect(APP_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
  });
});
