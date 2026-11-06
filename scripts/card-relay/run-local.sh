#!/usr/bin/env bash
# The card relay harness (ENG-821), in one command:
#
#   scripts/card-relay/run-local.sh /absolute/path/to/cashucard-checkout
#
# The checkout is cashucard/cashucard at the 2.2 applet (e8e2694 or later). This
# builds its cardsim, starts it and a throwaway Nutshell 0.20.3 FakeWallet mint
# in Docker on free loopback ports, runs
# __tests__/integration/cardRelayDemo.test.ts against them, and removes what it
# started. Needs Node 22 with this repo's dependencies installed, JDK 17, Maven
# and Docker. No device, no reader, no network service but the two it starts.
#
# The mint is seeded as Nutshell 0.19.2 and reopened as 0.20.3 on the same
# volume, so its keyset has an 8-byte id (forge's shape): a 2.2 card's packet
# names keysets by 8 bytes, and the relay engine looks them up as given.
set -euo pipefail

cashu_card="${1:-}"
if [[ -z "$cashu_card" || "$cashu_card" != /* || ! -f "$cashu_card/tools/assisted-relay/relay.js" ]]; then
  echo "usage: $0 /absolute/path/to/cashucard-checkout (with tools/assisted-relay/relay.js)" >&2
  exit 2
fi
repo="$(cd "$(dirname "$0")/../.." && pwd)"
nutshell="${NUTSHELL_VERSION:-0.20.3}"
id="flashpos-card-relay-$(node -e 'process.stdout.write(require("crypto").randomBytes(4).toString("hex"))')"
free_port() {
  node -e 'const s=require("net").createServer();s.listen(0,"127.0.0.1",()=>{process.stdout.write(String(s.address().port));s.close()})'
}
cardsim_port="$(free_port)"
mint_port="$(free_port)"
log_dir="$(mktemp -d "${TMPDIR:-/tmp}/card-relay.XXXXXX")"
cardsim_pid=""

cleanup() {
  [[ -n "$cardsim_pid" ]] && kill "$cardsim_pid" 2>/dev/null || true
  docker rm -f "$id" > /dev/null 2>&1 || true
  docker volume rm "$id" > /dev/null 2>&1 || true
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
  docker run -d --name "$id" -p "127.0.0.1:$mint_port:3338" \
    -v "$id:/app/data" -e CASHU_DIR=/app/data \
    -e MINT_BACKEND_BOLT11_SAT=FakeWallet -e FAKEWALLET_BRR=TRUE \
    -e MINT_LISTEN_HOST=0.0.0.0 -e MINT_LISTEN_PORT=3338 \
    -e MINT_PRIVATE_KEY="PUBLIC_TEST_KEY_$id" -e MINT_INPUT_FEE_PPK=0 \
    -e MINT_RATE_LIMIT=FALSE "$@" \
    "cashubtc/nutshell:$nutshell" poetry run mint > /dev/null
}

echo "building cardsim in $cashu_card"
mvn -B -q -f "$cashu_card/tools/cardsim/pom.xml" package > "$log_dir/mvn.log" 2>&1 ||
  { cat "$log_dir/mvn.log" >&2; exit 1; }
java -jar "$cashu_card/tools/cardsim/target/cardsim.jar" --port "$cardsim_port" \
  > "$log_dir/cardsim.log" 2>&1 &
cardsim_pid=$!
wait_for "http://127.0.0.1:$cardsim_port/state"

docker volume create "$id" > /dev/null
mint -e VERSION=0.19.2
wait_for "http://127.0.0.1:$mint_port/v1/keysets"
docker rm -f "$id" > /dev/null
mint
wait_for "http://127.0.0.1:$mint_port/v1/keysets"
keysets="$(curl -sf "http://127.0.0.1:$mint_port/v1/keysets")"
echo "mint keysets: $keysets"

cd "$repo"
CARD_RELAY_CARDSIM="http://127.0.0.1:$cardsim_port" \
  CARD_RELAY_MINT="http://127.0.0.1:$mint_port" \
  CARD_RELAY_CASHU_CARD="$cashu_card" \
  node_modules/.bin/jest __tests__/integration/cardRelayDemo.test.ts \
  --selectProjects ios --ci --runInBand
