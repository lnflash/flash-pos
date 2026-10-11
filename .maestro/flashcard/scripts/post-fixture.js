// Puts the card into a new state mid-flow: cardsim /reset, then /fixture.
//
// env: BRIDGE_URL — the cardsim bridge; FIXTURE — a /fixture body (JSON),
// built by scripts/e2e-flashcard.mjs. The card key survives /reset, so the
// proofs in FIXTURE (minted to it) stay valid.
//
// Throws on anything but 200: a 409 names the fixture step the applet
// refused, and a flow that went on would be testing a card it did not set up.
var base = BRIDGE_URL.replace(/\/+$/, '');
var headers = {'Content-Type': 'application/json'};

var reset = http.post(base + '/reset', {body: '{}', headers: headers});
if (reset.status !== 200) {
  throw new Error(
    'cardsim /reset answered ' + reset.status + ': ' + reset.body,
  );
}

var applied = http.post(base + '/fixture', {body: FIXTURE, headers: headers});
if (applied.status !== 200) {
  throw new Error(
    'cardsim /fixture answered ' + applied.status + ': ' + applied.body,
  );
}
var state = json(applied.body);
console.log(
  'card fixture applied: ' +
    state.balance +
    ' sat, ' +
    state.counts.unspent +
    ' unspent / ' +
    state.counts.spent +
    ' spent / ' +
    state.counts.empty +
    ' empty',
);
