import {
  getBalanceFromHtml,
  getLnurlFromHtml,
  getTransactionsFromHtml,
} from '../../src/utils/flashcardParser';

const fixtureLnurl =
  'lnurl1dp68gurn8ghj7mrww4exctnrdakj7mrww4excuqpyys8wumn8ghj7un9d3shjtnwdaehgu3wvfskcmr0';

const fixtureHtml = `
  <html>
    <body>
      <a href="lightning:${fixtureLnurl}">Withdraw</a>
      <dl>
        <dt>12,345 SATS</dt>
      </dl>
      <table>
        <tr>
          <td><time datetime="2026-06-20T10:11:12Z">Jun 20</time></td>
          <td><span>1,234 SATS</span></td>
        </tr>
        <tr>
          <td><time datetime="2026-06-21T01:02:03Z">Jun 21</time></td>
          <td><span>-25 SATS</span></td>
        </tr>
      </table>
    </body>
  </html>
`;

describe('flashcardParser', () => {
  it('extracts an LNURL from a lightning link', () => {
    expect(getLnurlFromHtml(fixtureHtml)).toBe(fixtureLnurl);
  });

  it('extracts an LNURL from data attributes', () => {
    expect(getLnurlFromHtml(`<button data-lnurl="${fixtureLnurl}" />`)).toBe(
      fixtureLnurl,
    );
  });

  it('returns undefined when no LNURL exists', () => {
    expect(getLnurlFromHtml('<html><body>No card data</body></html>')).toBe(
      undefined,
    );
  });

  it('parses the card balance as sats', () => {
    expect(getBalanceFromHtml(fixtureHtml)).toBe(12345);
  });

  it('returns undefined when no balance exists', () => {
    expect(getBalanceFromHtml('<html><body>No balance</body></html>')).toBe(
      undefined,
    );
  });

  it('parses positive and negative transaction rows', () => {
    expect(getTransactionsFromHtml(fixtureHtml)).toEqual([
      {
        date: '2026-06-20T10:11:12Z',
        sats: '1,234',
      },
      {
        date: '2026-06-21T01:02:03Z',
        sats: '-25',
      },
    ]);
  });

  it('returns undefined when no transactions exist', () => {
    expect(getTransactionsFromHtml('<table></table>')).toBe(undefined);
  });
});
