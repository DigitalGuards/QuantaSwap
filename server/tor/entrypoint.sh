#!/bin/sh
set -eu

umask 077

resolve_ipv4() {
  lookup_name=$1
  lookup_result=$(getent ahostsv4 "$lookup_name") || {
    echo "Network address for $lookup_name is unavailable" >&2
    exit 1
  }
  set -- $lookup_result
  lookup_address=${1:-}
  case "$lookup_address" in
    *[!0-9.]* | "")
      echo "Network address for $lookup_name is invalid" >&2
      exit 1
      ;;
  esac
  printf '%s\n' "$lookup_address"
}

socks_address=$(resolve_ipv4 tor-socks)
orderbook_address=$(resolve_ipv4 orderbook)
: > /var/lib/quantaswap-tor/data/notices.log

exec tor --defaults-torrc /dev/null --torrc-file /etc/tor/torrc \
  --SocksPort "${socks_address}:9050 IsolateDestAddr IsolateDestPort" \
  --SocksPolicy "accept ${orderbook_address}" \
  --SocksPolicy "reject *" \
  --HiddenServiceDir /var/lib/quantaswap-tor/hidden-service \
  --HiddenServiceVersion 3 \
  --HiddenServicePort "80 ${orderbook_address}:8091"
