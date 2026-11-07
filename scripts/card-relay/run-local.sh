#!/usr/bin/env bash
# The card relay harness (ENG-821, ENG-824), in one command:
#
#   scripts/card-relay/run-local.sh /absolute/path/to/cashucard-checkout [v2|legacy8|both]
#
# The checkout is cashucard/cashucard at the 2.2 applet with the relay engine's
# unique-prefix keyset resolution (cashucard#235, df3f0bf or later). This
# builds its cardsim, starts it and a throwaway Nutshell 0.20.3 FakeWallet mint
# in Docker on free loopback ports, runs
# __tests__/integration/cardRelayDemo.test.ts against them, and removes what it
# started. Needs Node 22 with this repo's dependencies installed, JDK 17, Maven
# and Docker. No device, no reader, no network service but the two it starts.
#
# A 2.2 card's packet names keysets by 8 bytes; the relay engine maps each to
# the mint's full id by unique prefix, and the till keeps the full id. The
# mode (second argument, else $CARD_RELAY_MINT_IDS, else both) picks the
# mint's keyset id shape:
#   v2       a fresh Nutshell 0.20.3 volume: a 33-byte (66-hex, "01") id.
#   legacy8  seeded as Nutshell 0.19.2, reopened as 0.20.3 on the same
#            volume: an 8-byte id (forge's shape).
#   both     v2, then legacy8, each against its own mint; fails if either does.
set -euo pipefail

cashu_card="${1:-}"
if [[ -z "$cashu_card" || "$cashu_card" != /* || ! -f "$cashu_card/tools/assisted-relay/relay.js" ]]; then
  echo "usage: $0 /absolute/path/to/cashucard-checkout (with tools/assisted-relay/relay.js) [v2|legacy8|both]" >&2
  exit 2
fi
mode="${2:-${CARD_RELAY_MINT_IDS:-both}}"
case "$mode" in
  v2 | legacy8) modes=("$mode") ;;
  both) modes=(v2 legacy8) ;;
  *)
    echo "mode must be v2, legacy8 or both, got: $mode" >&2
    exit 2
    ;;
esac
repo="$(cd "$(dirname "$0")/../.." && pwd)"
nutshell="${NUTSHELL_VERSION:-0.20.3}"
id="flashpos-card-relay-$(node -e 'process.stdout.write(require("crypto").randomBytes(4).toString("hex"))')"
free_port() {
  node -e 'const s=require("net").createServer();s.listen(0,"127.0.0.1",()=>{process.stdout.write(String(s.address().port));s.close()})'
}
cardsim_port="$(free_port)"
log_dir="$(mktemp -d "${TMPDIR:-/tmp}/card-relay.XXXXXX")"
cardsim_pid=""
mint_name=""
mint_port=""

remove_mint() {
  # $1: the mint's container and volume name.
  docker rm -f "$1" > /dev/null 2>&1 || true
  docker volume rm "$1" > /dev/null 2>&1 || true
}

cleanup() {
  [[ -n "$cardsim_pid" ]] && kill "$cardsim_pid" 2>/dev/null || true
  for m in v2 legacy8; do
    remove_mint "$id-$m"
  done
}
trap cleanup EXIT

wait_for() {
  for _ in $(seq 1 120); do
    if curl -sf "$1" > /dev/null; then return 0; fi
    sleep 1
  done
  echo "timed out waiting for $1 (logs: $log_dir)" >&2
  return 1
}

mint() {
  docker run -d --name "$mint_name" -p "127.0.0.1:$mint_port:3338" \
    -v "$mint_name:/app/data" -e CASHU_DIR=/app/data \
    -e MINT_BACKEND_BOLT11_SAT=FakeWallet -e FAKEWALLET_BRR=TRUE \
    -e MINT_LISTEN_HOST=0.0.0.0 -e MINT_LISTEN_PORT=3338 \
    -e MINT_PRIVATE_KEY="PUBLIC_TEST_KEY_$mint_name" -e MINT_INPUT_FEE_PPK=0 \
    -e MINT_RATE_LIMIT=FALSE "$@" \
    "cashubtc/nutshell:$nutshell" poetry run mint > /dev/null
}

# Start the mint for one mode and check its active sat keyset has that
# mode's id shape, so a wrongly seeded mint fails here, not silently later.
start_mint() {
  local m="$1"
  mint_name="$id-$m"
  mint_port="$(free_port)"
  docker volume create "$mint_name" > /dev/null
  if [[ "$m" == legacy8 ]]; then
    mint -e VERSION=0.19.2
    wait_for "http://127.0.0.1:$mint_port/v1/keysets"
    docker rm -f "$mint_name" > /dev/null
  fi
  mint
  wait_for "http://127.0.0.1:$mint_port/v1/keysets"
  local keysets
  keysets="$(curl -sf "http://127.0.0.1:$mint_port/v1/keysets")"
  echo "mint keysets ($m): $keysets"
  # shellcheck disable=SC2016 # JavaScript, not shell: nothing to expand.
  KEYSETS="$keysets" MODE="$m" node -e '
    const {keysets} = JSON.parse(process.env.KEYSETS);
    const active = keysets.filter(k => k.active && k.unit === "sat");
    const want = process.env.MODE === "v2" ? /^01[0-9a-f]{64}$/ : /^[0-9a-f]{16}$/;
    if (active.length !== 1 || !want.test(active[0].id)) {
      console.error(
        `expected one active sat keyset with a ${process.env.MODE} id, got ` +
          JSON.stringify(active.map(k => k.id)),
      );
      process.exit(1);
    }
  '
}

echo "building cardsim in $cashu_card"
mvn -B -q -f "$cashu_card/tools/cardsim/pom.xml" package > "$log_dir/mvn.log" 2>&1 ||
  { cat "$log_dir/mvn.log" >&2; exit 1; }
java -jar "$cashu_card/tools/cardsim/target/cardsim.jar" --port "$cardsim_port" \
  > "$log_dir/cardsim.log" 2>&1 &
cardsim_pid=$!
wait_for "http://127.0.0.1:$cardsim_port/state"

cd "$repo"
if [[ ! -f .env ]]; then
  # The babel env plugin needs a .env to load any module that imports @env;
  # the tests read none of it (jest maps @env to __mocks__/@env.js).
  echo "no .env: copying .env.example (as CI does)"
  cp .env.example .env
fi

failed=()
for m in "${modes[@]}"; do
  echo "== card relay, $m keyset ids =="
  start_mint "$m"
  if ! CARD_RELAY_CARDSIM="http://127.0.0.1:$cardsim_port" \
    CARD_RELAY_MINT="http://127.0.0.1:$mint_port" \
    CARD_RELAY_CASHU_CARD="$cashu_card" \
    CARD_RELAY_EXPECT_IDS="$m" \
    node_modules/.bin/jest __tests__/integration/cardRelayDemo.test.ts \
    --selectProjects ios --ci --runInBand; then
    failed+=("$m")
  fi
  remove_mint "$mint_name"
done

if ((${#failed[@]})); then
  echo "card relay failed for: ${failed[*]}" >&2
  exit 1
fi
