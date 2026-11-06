#!/bin/sh
# プロモ動画を作り直す。
#   sh promo/build.sh
# 1. 各シーンの数字を data/stats.json から入れ直す
# 2. promo/scene.html を 1920x1080 で15枚のPNGに書き出す
# 3. ffmpeg でゆっくりズーム＋クロスフェードしてつなぐ
set -e
cd "$(dirname "$0")/.."

CHROME="${CHROME:-/Applications/Google Chrome.app/Contents/MacOS/Google Chrome}"
PORT="${PORT:-8743}"
TMP="${TMPDIR:-/tmp}/leakscan-promo-chrome"

[ -x "$CHROME" ] || { echo "Chrome が見つかりません: $CHROME"; exit 1; }
command -v ffmpeg >/dev/null || { echo "ffmpeg が必要です"; exit 1; }

node promo/update-scenes.mjs

python3 -m http.server "$PORT" >/dev/null 2>&1 &
SRV=$!
trap 'kill $SRV 2>/dev/null || true' EXIT
sleep 1.5

i=1
while [ "$i" -le 15 ]; do
  n=$(printf "%02d" "$i")
  "$CHROME" --headless --disable-gpu --hide-scrollbars --force-device-scale-factor=1 \
    --window-size=1920,1080 --virtual-time-budget=3000 \
    --user-data-dir="$TMP" \
    --screenshot="promo/frames/s$n.png" \
    "http://127.0.0.1:$PORT/promo/scene.html?s=$i" >/dev/null 2>&1
  [ -s "promo/frames/s$n.png" ] || { echo "シーン $i の書き出しに失敗"; exit 1; }
  i=$((i + 1))
done
echo "15シーンを書き出しました"

sh promo/cmd.sh
echo "promo/leakscan-promo.mp4 を生成しました"
ffprobe -v error -show_entries format=duration,size -of default=nw=1 promo/leakscan-promo.mp4
