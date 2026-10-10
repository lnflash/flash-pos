import fs from 'fs';
import path from 'path';
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

describe('fastlane release commits stage package.json', () => {
  // The version-from-tag helpers stamp package.json; every lane commit that
  // follows must stage it, or the committed JS-visible version drifts behind
  // the native one (the iOS beta lane missed this once).
  const fastfile = fs.readFileSync(
    path.join(__dirname, '../../fastlane/Fastfile'),
    'utf8',
  );

  it('every commit_version_bump includes package.json', () => {
    expect(fastfile.match(/commit_version_bump\(/g)).toHaveLength(2);
    expect(fastfile.match(/include: \["package\.json"\]/g)).toHaveLength(2);
  });

  it('every git_commit stages package.json', () => {
    expect(fastfile.match(/git_commit\(/g)).toHaveLength(2);
    expect(
      fastfile.match(
        /path: \["android\/app\/build\.gradle", "package\.json"\]/g,
      ),
    ).toHaveLength(2);
  });
});
