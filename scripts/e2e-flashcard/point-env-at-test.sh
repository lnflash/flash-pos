#!/usr/bin/env bash
# Points an .env copied from .env.example at the TEST instance and the local
# FakeWallet mint, then refuses it if any flashapp.me host but TEST is left.
# The e2e workflow (.github/workflows/e2e-flashcard.yml) runs it; jest pins
# it (__tests__/scripts/pointEnvAtTest.test.ts).
#
#   scripts/e2e-flashcard/point-env-at-test.sh <.env> <mint url>
#
# BTC_PAY_SERVER has no TEST twin the e2e build may use, so it goes to an
# RFC 6761 .invalid host: a flow that ever reaches Invoice or Rewards fails
# on DNS instead of talking to production BTCPay.
set -euo pipefail

ENV_FILE=${1:?usage: point-env-at-test.sh <.env> <mint url>}
MINT_URL=${2:?usage: point-env-at-test.sh <.env> <mint url>}

# sed -i differs between BSD (macOS) and GNU; a temp file works on both.
tmp=$(mktemp)
trap 'rm -f "$tmp"' EXIT
sed \
  -e 's#^FLASH_GRAPHQL_URI=.*#FLASH_GRAPHQL_URI=https://api.test.flashapp.me/graphql#' \
  -e 's#^FLASH_GRAPHQL_WS_URI=.*#FLASH_GRAPHQL_WS_URI=wss://ws.test.flashapp.me/graphql#' \
  -e 's#^FLASH_LN_ADDRESS_URL=.*#FLASH_LN_ADDRESS_URL=https://test.flashapp.me#' \
  -e 's#^FLASH_LN_ADDRESS=.*#FLASH_LN_ADDRESS=test.flashapp.me#' \
  -e "s#^FLASH_CASHU_MINT_URL=.*#FLASH_CASHU_MINT_URL=$MINT_URL#" \
  -e 's#^BTC_PAY_SERVER=.*#BTC_PAY_SERVER=https://btcpay.invalid#' \
  "$ENV_FILE" > "$tmp"
cat "$tmp" > "$ENV_FILE"

# Never production: any flashapp.me host, on any key, as a URL or a bare
# value, unless it is TEST (test.flashapp.me or a host under it).
HOST='([a-z0-9-]+\.)*'
END='([/:?#[:space:]"'"'"']|$)'
if grep -vE '^[[:space:]]*#' "$ENV_FILE" |
  grep -iE "(://|=)${HOST}flashapp\.me${END}" |
  grep -viE "(://|=)${HOST}test\.flashapp\.me${END}"; then
  echo "::error::.env still points at a flashapp.me host that is not TEST" >&2
  exit 1
fi
