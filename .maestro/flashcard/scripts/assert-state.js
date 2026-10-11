// Asserts what the card holds, from cardsim GET /state (never through the
// app): copy on screen can lie about money, slots cannot.
//
// env:
//   BRIDGE_URL  the cardsim bridge
//   EXPECT      JSON, any of:
//     unspent        exact multiset of the amounts in unspent slots
//     spentLabels    fixture labels whose proofs must sit in spent slots
//     unspentLabels  fixture labels whose proofs must sit in unspent slots
//   NONCES      JSON label → nonce, from scripts/e2e-flashcard.mjs
//
// Always: no nonce sits in more than one slot (a replayed LOAD would put a
// second copy of a proof on the card — a phantom balance).
var expect = json(EXPECT);
var nonces = json(NONCES);
var res = http.get(BRIDGE_URL.replace(/\/+$/, '') + '/state');
if (res.status !== 200) {
  throw new Error('cardsim /state answered ' + res.status + ': ' + res.body);
}
var state = json(res.body);
var filled = state.slots.filter(function (s) {
  return s.status !== 'empty';
});

var seen = {};
filled.forEach(function (s) {
  if (seen[s.nonce] !== undefined) {
    throw new Error(
      'nonce ' + s.nonce + ' is in slots ' + seen[s.nonce] + ' and ' + s.slot,
    );
  }
  seen[s.nonce] = s.slot;
});

function sorted(list) {
  return list.slice().sort(function (a, b) {
    return a - b;
  });
}

if (expect.unspent) {
  var got = sorted(
    filled
      .filter(function (s) {
        return s.status === 'unspent';
      })
      .map(function (s) {
        return s.amount;
      }),
  );
  var want = sorted(expect.unspent);
  if (JSON.stringify(got) !== JSON.stringify(want)) {
    throw new Error(
      'unspent amounts: expected ' +
        JSON.stringify(want) +
        ', card holds ' +
        JSON.stringify(got),
    );
  }
}

function checkLabels(labels, status) {
  (labels || []).forEach(function (label) {
    var nonce = nonces[label];
    if (!nonce) {
      throw new Error('no nonce for fixture label ' + label);
    }
    var slot = filled.filter(function (s) {
      return s.nonce === nonce;
    })[0];
    if (!slot) {
      throw new Error(label + ' (' + nonce + ') is not on the card');
    }
    if (slot.status !== status) {
      throw new Error(
        label +
          ' in slot ' +
          slot.slot +
          ' is ' +
          slot.status +
          ', not ' +
          status,
      );
    }
  });
}
checkLabels(expect.spentLabels, 'spent');
checkLabels(expect.unspentLabels, 'unspent');

console.log(
  'card state ok: ' + state.balance + ' sat, ' + JSON.stringify(expect),
);
