#!/bin/zsh
# 宣伝動画を作り直す。
#   sh promo/v2/build.sh
#
# 時刻（行の開始・場面の境目・尺）は promo/v2/cues.json が正。
# 絵も音もそこから読むので、間を変えたいときは cues.json だけ直せばよい。
# cues.json は promo/v2/retime.py が、音声の実測の長さから作り直せる。
#
# 台詞そのものを変えたときは、先にナレーションを作り直す:
#   ~/dev/okotozuke-ads/bin/narrate promo/v2/lines.json promo/v2/vo
set -euo pipefail
cd "$(dirname "$0")/../.."

V=promo/v2
OUT=$V/leakscan-promo.mp4
C=$V/cues.json

command -v ffmpeg >/dev/null || { echo "ffmpeg が要ります"; exit 1; }
[ -f "$C" ] || { echo "$C がありません（python3 promo/v2/retime.py で作れます）"; exit 1; }

FPS=$(python3 -c "import json;print(json.load(open('$C'))['fps'])")
DUR=$(python3 -c "import json;print(json.load(open('$C'))['dur'])")

echo "1/3 コマを書き出す（${DUR}秒 × ${FPS}fps）"
node $V/render.mjs $V/frames

echo "2/3 音を組む"
# 各行を cues.json の時刻に置いて1本にし、配信で使われる -14 LUFS に合わせる。
# normalize=0 は amix に本数で割らせない指定（声が小さくならないように）。
python3 $V/mixargs.py "$C" "$V" > "$V/.ffargs"
eval ffmpeg -v error -y "$(cat "$V/.ffargs")" -map '"[a]"' -ar 48000 -ac 2 -c:a pcm_s16le "$V/audio.wav"
rm -f "$V/.ffargs"

echo "3/3 映像と合わせる"
ffmpeg -v error -y -framerate $FPS -i "$V/frames/f%04d.png" -i $V/audio.wav \
  -c:v libx264 -preset slow -crf 17 -pix_fmt yuv420p -profile:v high -level 4.1 \
  -x264-params "keyint=60:min-keyint=30" \
  -c:a aac -b:a 192k -ar 48000 -ac 2 \
  -movflags +faststart -shortest "$OUT"

echo "できました: $OUT"
ffprobe -v error -show_entries format=duration,size -show_entries stream=codec_name,width,height \
  -of default=noprint_wrappers=1 "$OUT"
