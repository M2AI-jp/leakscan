"""音声の実測の長さから cues.json を作り直す。
   台詞を録り直したら、これを流してから build.sh。
   使い方: python3 promo/v2/retime.py"""
import json, pathlib, subprocess, sys

V = pathlib.Path(__file__).parent
IDS = [l['id'] for l in json.loads((V / 'lines.json').read_text(encoding='utf-8'))]

HEAD, GAP, TAIL = 0.50, 0.85, 1.35
# GAP は行と行の間。VOICEPEAK の文中の息継ぎが 0.42 秒なので、
# それよりはっきり広くしないと、話の切れ目が聞き手に伝わらない。

def dur(i):
    out = subprocess.run(['ffprobe', '-v', 'error', '-show_entries', 'format=duration',
                          '-of', 'csv=p=0', str(V / 'vo' / f'{i}.wav')], capture_output=True, text=True)
    if out.returncode: sys.exit(f'音がありません: vo/{i}.wav')
    return float(out.stdout.strip())

lines, t = [], HEAD
for i in IDS:
    d = dur(i)
    lines.append({'id': i, 'at': round(t, 2), 'dur': round(d, 3)})
    t += d + GAP
total = round(t - GAP + TAIL, 2)

scenes, prev = [], 0.0
for k, ln in enumerate(lines):
    if k:
        cut = round(ln['at'] - GAP * 0.62, 2)   # 場面の切り替えは間のまん中より少し手前
        scenes[-1]['b'] = cut
        prev = cut
    scenes.append({'el': f'#s{k+1}', 'a': prev, 'b': total})

(V / 'cues.json').write_text(json.dumps(
    {'fps': 30, 'dur': total, 'xf': 0.42, 'lines': lines, 'scenes': scenes},
    ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
print(f'cues.json を書きました（全体 {total} 秒 / {len(lines)} 行）')
