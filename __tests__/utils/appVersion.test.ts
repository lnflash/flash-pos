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

  // Returns the argument text of each `name(...)` call, balancing nested
  // parens (the release message embeds `get_version_number(...)`).
  const callsOf = (name: string): string[] => {
    const calls: string[] = [];
    const re = new RegExp(`\\b${name}\\(`, 'g');
    let m: RegExpExecArray | null;
    while ((m = re.exec(fastfile)) !== null) {
      let depth = 1;
      let i = m.index + m[0].length;
      const start = i;
      while (i < fastfile.length && depth > 0) {
        if (fastfile[i] === '(') {
          depth++;
        } else if (fastfile[i] === ')') {
          depth--;
        }
        i++;
      }
      calls.push(fastfile.slice(start, i - 1));
    }
    return calls;
  };

  it('has the expected number of version commits', () => {
    expect(callsOf('commit_version_bump')).toHaveLength(2);
    expect(callsOf('git_commit')).toHaveLength(2);
  });

  it('every commit_version_bump includes package.json', () => {
    for (const call of callsOf('commit_version_bump')) {
      expect(call).toMatch(/include:\s*\[[^\]]*"package\.json"/);
    }
  });

  it('every git_commit stages package.json', () => {
    for (const call of callsOf('git_commit')) {
      expect(call).toMatch(/path:\s*\[[^\]]*"package\.json"/);
    }
  });
});
