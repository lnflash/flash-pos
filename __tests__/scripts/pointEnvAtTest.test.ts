import {spawnSync} from 'child_process';
import {mkdtempSync, readFileSync, rmSync, writeFileSync} from 'fs';
import {tmpdir} from 'os';
import {join} from 'path';

// scripts/e2e-flashcard/point-env-at-test.sh: the e2e workflow's guard that
// the simulator build never talks to production. It runs on macOS in the
// workflow; it is plain bash + sed + grep, so it runs here on Linux too.
const ROOT = join(__dirname, '../..');
const SCRIPT = join(ROOT, 'scripts/e2e-flashcard/point-env-at-test.sh');
const MINT = 'http://127.0.0.1:3338';

describe('point-env-at-test.sh', () => {
  let dir: string;
  let env: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'point-env-'));
    env = join(dir, '.env');
  });
  afterEach(() => rmSync(dir, {recursive: true, force: true}));

  const run = (content: string) => {
    writeFileSync(env, content);
    const result = spawnSync('bash', [SCRIPT, env, MINT], {encoding: 'utf8'});
    return {...result, env: readFileSync(env, 'utf8')};
  };
  const value = (text: string, key: string) =>
    text.match(new RegExp(`^${key}=(.*)$`, 'm'))?.[1];

  it('points .env.example at TEST, the local mint and no BTCPay', () => {
    const result = run(readFileSync(join(ROOT, '.env.example'), 'utf8'));
    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
    expect(value(result.env, 'FLASH_GRAPHQL_URI')).toBe(
      'https://api.test.flashapp.me/graphql',
    );
    expect(value(result.env, 'FLASH_GRAPHQL_WS_URI')).toBe(
      'wss://ws.test.flashapp.me/graphql',
    );
    expect(value(result.env, 'FLASH_LN_ADDRESS_URL')).toBe(
      'https://test.flashapp.me',
    );
    expect(value(result.env, 'FLASH_LN_ADDRESS')).toBe('test.flashapp.me');
    expect(value(result.env, 'FLASH_CASHU_MINT_URL')).toBe(MINT);
    expect(value(result.env, 'BTC_PAY_SERVER')).toBe('https://btcpay.invalid');
  });

  it('leaves no flashapp.me host but TEST anywhere in .env.example', () => {
    const {env: out} = run(readFileSync(join(ROOT, '.env.example'), 'utf8'));
    const hosts = out
      .split('\n')
      .filter(line => !line.trimStart().startsWith('#'))
      .flatMap(line => line.match(/[a-z0-9.-]*flashapp\.me/gi) ?? []);
    expect(hosts.length).toBeGreaterThan(0);
    for (const host of hosts) {
      expect(host).toMatch(/(^|\.)test\.flashapp\.me$/);
    }
  });

  it.each([
    [
      'production BTCPay on a key the sed does not know',
      'BTC_PAY=https://btcpay.flashapp.me',
    ],
    ['the production mint on any key', 'OTHER_MINT=https://forge.flashapp.me'],
    ['the apex as a URL', 'SOME_URL=https://flashapp.me/x'],
    ['a bare production host', 'SOME_ADDRESS=flashapp.me'],
    ['a websocket host', 'WS=wss://ws.flashapp.me/graphql'],
    ['upper case', 'X=HTTPS://API.FLASHAPP.ME'],
  ])('refuses %s', (_label, line) => {
    const result = run(`FLASH_GRAPHQL_URI=x\n${line}\n`);
    expect(result.status).toBe(1);
    expect(result.stdout).toContain(line.split('=')[0]);
    expect(result.stderr).toContain('not TEST');
  });

  it.each([
    ['a TEST host', 'A=https://btcpay.test.flashapp.me'],
    ['a host under TEST', 'B=https://forge.mint.test.flashapp.me/v1'],
    ['a commented production host', '# was https://api.flashapp.me'],
    ['a different domain', 'C=https://notflashapp.me.example.com'],
  ])('accepts %s', (_label, line) => {
    const result = run(`${line}\n`);
    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
  });

  it('the workflow runs it, with pipefail on every step', () => {
    const workflow = readFileSync(
      join(ROOT, '.github/workflows/e2e-flashcard.yml'),
      'utf8',
    );
    expect(workflow).toContain(
      'scripts/e2e-flashcard/point-env-at-test.sh .env "$MINT_URL"',
    );
    // An explicit `shell: bash` is `bash --noprofile --norc -eo pipefail`;
    // the implicit default (`bash -e`) lets `xcodebuild … | tail` pass.
    expect(workflow).toMatch(/\n {4}defaults:\n {6}run:\n {8}shell: bash\n/);
    expect(workflow).not.toMatch(/^\s+shell: (?!bash$).*$/m);
  });
});
