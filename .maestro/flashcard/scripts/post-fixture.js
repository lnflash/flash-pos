// Puts the card into a new state mid-flow: cardsim /reset, then /fixture.
//
// env: BRIDGE_URL — the cardsim bridge; FIXTURE — a /fixture body (JSON),
// built by scripts/e2e-flashcard.mjs. The card key survives /reset, so the
// pieces in FIXTURE (minted to it) stay valid.
//   RESET='false'      apply FIXTURE on top of the card as it is: a 2.0
//                      card's change openings (the change it is owed) live
//                      on the card, and /reset would wipe them.
//   CLEAR_SPENT='true' first free the card's spent slots (SELECT, then
//                      CLEAR_SPENT: the tap after a payment may, with no PIN).
//
// Throws on anything but 200 / 9000: a 409 names the fixture step the applet
// refused, and a flow that went on would be testing a card it did not set up.
var base = BRIDGE_URL.replace(/\/+$/, '');
var headers = {'Content-Type': 'application/json'};

function apdu(hex) {
  var res = http.post(base + '/apdu', {
    body: JSON.stringify({hex: hex}),
    headers: headers,
  });
  if (res.status !== 200) {
    throw new Error('cardsim /apdu answered ' + res.status + ': ' + res.body);
  }
  var answer = json(res.body);
  if (answer.sw !== '9000') {
    throw new Error('the card answered ' + answer.sw + ' to ' + hex);
  }
  return answer.hex;
}

if (typeof RESET === 'undefined' || RESET !== 'false') {
  var reset = http.post(base + '/reset', {body: '{}', headers: headers});
  if (reset.status !== 200) {
    throw new Error(
      'cardsim /reset answered ' + reset.status + ': ' + reset.body,
    );
  }
}

if (typeof CLEAR_SPENT !== 'undefined' && CLEAR_SPENT === 'true') {
  apdu('00A404000AF043415348554341524400');
  var freed = apdu('B031000001');
  console.log('cleared spent slots: ' + parseInt(freed.slice(0, 2), 16));
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
