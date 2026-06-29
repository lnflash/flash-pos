export function getLnurlFromHtml(html: string): string | undefined {
  const patterns = [
    /href="lightning:(lnurl\w+)"/i,
    /lightning:(lnurl[a-zA-Z0-9]+)/i,
    /'lightning:(lnurl[a-zA-Z0-9]+)'/i,
    /"lightning:(lnurl[a-zA-Z0-9]+)"/i,
    /(lnurl[a-zA-Z0-9]{50,})/i,
    /data-lnurl="(lnurl[a-zA-Z0-9]+)"/i,
    /value="(lnurl[a-zA-Z0-9]+)"/i,
    /\b(lnurl[a-zA-Z0-9]+)\b/i,
  ];

  for (const pattern of patterns) {
    const match = html.match(pattern);

    if (match?.[1]) {
      return match[1];
    }
  }

  return undefined;
}

export function getBalanceFromHtml(html: string): number | undefined {
  const balanceMatch = html.match(/(\d{1,3}(?:,\d{3})*)\s*SATS<\/dt>/i);
  if (!balanceMatch) {
    return undefined;
  }

  return parseInt(balanceMatch[1].replace(/,/g, ''), 10);
}

export function getTransactionsFromHtml(
  html: string,
): TransactionList | undefined {
  const transactionMatches = [
    ...html.matchAll(
      /<time datetime="(.*?)".*?>.*?<\/time>\s*<\/td>\s*<td.*?>\s*<span.*?>(-?\d{1,3}(?:,\d{3})*) SATS<\/span>/g,
    ),
  ];
  const data = transactionMatches.map(match => ({
    date: match[1],
    sats: match[2],
  }));

  return data.length > 0 ? data : undefined;
}
