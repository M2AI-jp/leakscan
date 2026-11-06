"""「リークスキャン」の音の上げ下げを、こちらで描き換える。

VOICEPEAK には読みしか渡せずアクセントは指定できないので、できあがった音声の
音程を直接作り変える。おことづけの広告工場の PSOLA（Praat のオーバーラップ加算。
長さは変えず高さだけ動かす）を借りる。あちらには書き込まない。

  python3 promo/v2/name/accent.py
"""
import json, sys, pathlib
sys.path.insert(0, '/Users/amano/dev/okotozuke-ads')

import numpy as np, parselmouth, soundfile as sf
from okoads.intonation.psola import psola_points, psola_array, match_energy, splice

V = pathlib.Path(__file__).parent
SRC = V / 'vo' / 'p01.wav'                 # 「リークスキャン。」
REC = json.loads((V / 'vo' / 'lines' / 'p01.json').read_text(encoding='utf-8'))
OUT = V / 'accent'; OUT.mkdir(exist_ok=True)

morae = [m for s in REC['sentences'] for m in s['morae']]
word = [m for m in morae if m['token_text'] in ('リークスキャン', 'リーク', 'スキャン')]
kana = [m['kana'] for m in word]
D = [m['after'] for m in word]
print('拍:', ' '.join(kana))
print('いまの高さ:', ' '.join('—' if d is None else '%.1f' % d for d in D))

H = max(d for d in D if d is not None)     # その語の一番高いところ

# 拍ごとの目標の高さ（H からの差、半音）。None の拍（無声化）は触らない。
#   リ  ー   ク   ス  キャ  ン
PAT = {
 # 平板（2番）と 中高・浅く（4番）の間を刻んだもの。
 # 上げ方（リ→ー）は共通で、下げ方だけを変える。
 'n1': dict(name='ほぼ平板（-0.3）',        v=[-3.5, 0.0, 0.0, None, -0.3, -0.8]),
 'n2': dict(name='わずかに下げる（-0.7）',    v=[-3.5, 0.0, 0.0, None, -0.7, -1.3]),
 'n3': dict(name='少し下げる（-1.0）',       v=[-3.5, 0.0, 0.0, None, -1.0, -1.8]),
 'n4': dict(name='やや下げる（-1.5）',       v=[-3.5, 0.0, 0.0, None, -1.5, -2.2]),
 'n5': dict(name='キャは高く、最後だけ下げる',  v=[-3.5, 0.0, 0.0, None, -0.4, -2.2]),
 'n6': dict(name='下げてから平ら',           v=[-3.5, 0.0, 0.0, None, -1.1, -1.1]),
 'n7': dict(name='上げ方を浅く＋ほぼ平板',     v=[-2.3, 0.0, 0.0, None, -0.4, -1.0]),
 'n8': dict(name='上げ方を深く＋ほぼ平板',     v=[-4.6, 0.0, 0.0, None, -0.4, -1.0]),
}

x, sr = sf.read(str(SRC), dtype='float64')
if x.ndim > 1: x = x.mean(axis=1)
snd = parselmouth.Sound(x, sampling_frequency=sr)

for key, p in PAT.items():
    assert len(p['v']) == len(word), f"{key}: 拍の数が合わない（{len(p['v'])} vs {len(word)}）"
    rows, deltas = [], []
    for m, off in zip(word, p['v']):
        if off is None or m.get('vowel_t0') is None or m['after'] is None:
            continue
        rows.append(m)
        deltas.append((H + off) - m['after'])
    pts = psola_points(rows, deltas, anchor='plateau')
    y = match_energy(x, psola_array(snd, pts), sr)
    out, share = splice(x, y, sr, pts, y=y, snd=snd)
    sf.write(str(OUT / f'{key}.wav'), out, sr)
    print('%-12s %-24s 動かした量 %s  （書き換えた割合 %.0f%%）'
          % (key, p['name'], ' '.join('%+.1f' % d for d in deltas), share * 100))
print('→', OUT)
