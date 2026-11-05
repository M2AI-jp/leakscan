#!/bin/sh
# leakscan.matsunai.com が正しく配信されているか確認する。
# macOSのDNSキャッシュが古い否定応答を持っていても確認できるよう、
# dig で引いたIPを --resolve に渡している。
HOST=leakscan.matsunai.com
IP=$(dig +short "$HOST" | grep -E '^[0-9.]+$' | head -1)
echo "DNS: ${IP:-(解決できません)}"
[ -z "$IP" ] && exit 1
R="--resolve $HOST:443:$IP"
# shellcheck disable=SC2086
curl -s -o /dev/null -w "HTTPS index: %{http_code}\n" $R --max-time 25 "https://$HOST/"
# shellcheck disable=SC2086
curl -s -o /dev/null -w "HTTPS list : %{http_code}\n" $R --max-time 25 "https://$HOST/list"
# shellcheck disable=SC2086
echo "CORS: $(curl -sI $R --max-time 25 "https://$HOST/data/breaches.json" | grep -i access-control-allow-origin | tr -d '\r')"
# shellcheck disable=SC2086
echo "収録件数: $(curl -s $R --max-time 25 "https://$HOST/data/breaches.json" | python3 -c 'import json,sys;print(len(json.load(sys.stdin)))')"
