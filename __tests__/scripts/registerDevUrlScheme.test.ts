import {execFileSync} from 'child_process';
import {existsSync, mkdtempSync, rmSync} from 'fs';
import {tmpdir} from 'os';
import {join} from 'path';

// ios/scripts/register-dev-url-scheme.sh is an Xcode build phase: it uses
// macOS's PlistBuddy, so it runs where Xcode runs. The Linux CI job skips
// it; the macOS e2e workflow also checks the built app's Info.plist.
const BUDDY = '/usr/libexec/PlistBuddy';
const onMac = process.platform === 'darwin' && existsSync(BUDDY);
const SCRIPT = join(__dirname, '../../ios/scripts/register-dev-url-scheme.sh');

(onMac ? describe : describe.skip)('register-dev-url-scheme.sh', () => {
  let dir: string;
  let plist: string;

  const run = (configuration: string) =>
    execFileSync('/bin/sh', [SCRIPT, plist], {
      env: {
        PATH: process.env.PATH,
        CONFIGURATION: configuration,
        PRODUCT_BUNDLE_IDENTIFIER: 'com.flash.pos',
      },
      encoding: 'utf8',
    });
  const urlTypes = () => {
    try {
      return JSON.parse(
        execFileSync(
          'plutil',
          ['-extract', 'CFBundleURLTypes', 'json', '-o', '-', plist],
          {encoding: 'utf8'},
        ),
      );
    } catch {
      return undefined;
    }
  };

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'url-scheme-'));
    plist = join(dir, 'Info.plist');
    execFileSync(BUDDY, ['-c', 'Add :CFBundleName string Flash', plist]);
  });

  afterEach(() => rmSync(dir, {recursive: true, force: true}));

  it('registers flashpos:// in Debug', () => {
    run('Debug');
    expect(urlTypes()).toEqual([
      {
        CFBundleURLName: 'com.flash.pos.dev-card-bridge',
        CFBundleURLSchemes: ['flashpos'],
      },
    ]);
  });

  it('is idempotent across incremental builds', () => {
    run('Debug');
    expect(run('Debug')).toContain('already registered');
    expect(urlTypes()).toHaveLength(1);
  });

  it('appends after URL types the app already declares', () => {
    execFileSync(BUDDY, [
      '-c',
      'Add :CFBundleURLTypes array',
      '-c',
      'Add :CFBundleURLTypes:0 dict',
      '-c',
      'Add :CFBundleURLTypes:0:CFBundleURLSchemes array',
      '-c',
      'Add :CFBundleURLTypes:0:CFBundleURLSchemes:0 string other',
      plist,
    ]);
    run('Debug');
    expect(
      urlTypes().map(
        (t: {CFBundleURLSchemes: string[]}) => t.CFBundleURLSchemes,
      ),
    ).toEqual([['other'], ['flashpos']]);
  });

  it('never registers it in Release', () => {
    expect(run('Release')).toContain('not registered');
    expect(urlTypes()).toBeUndefined();
  });
});
