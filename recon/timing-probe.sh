#!/bin/sh
# R8: where does a request's time go? Compares fresh connections with a reused
# one, per step. Anonymous and read-only. Run it on the temporary VM too.
# Usage: sh recon/timing-probe.sh [count] [path]
COUNT=${1:-10}
URL="https://zdrofit.pl${2:-/zajecia}"
AGENT="Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36"
FORMAT='%{remote_ip} h%{http_version} %{http_code} dns=%{time_namelookup} tcp=%{time_connect} tls=%{time_appconnect} ttfb=%{time_starttransfer} total=%{time_total} cache=%header{x-cache}\n'

echo "--- new connection each time"
i=0
while [ "$i" -lt "$COUNT" ]; do
  curl -s -o /dev/null -A "$AGENT" -w "$FORMAT" "$URL"
  sleep 2
  i=$((i + 1))
done

echo "--- one reused connection"
TRANSFERS=""
i=0
while [ "$i" -lt "$COUNT" ]; do
  TRANSFERS="$TRANSFERS -o /dev/null $URL"
  i=$((i + 1))
done
# shellcheck disable=SC2086
curl -s -A "$AGENT" --rate 30/m -w "$FORMAT" $TRANSFERS
