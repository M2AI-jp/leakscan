"""「2026年に」をひと続きに聞こえるようにならす。

VOICEPEAK は「にせん／にじゅう／ろくねんに」と3つのかたまりに切って、
山を3回作っている。日本語ではひと続きに読むところなので訛って聞こえる。
山を1つにして、最後の「に」の落ち方も浅くする。

  python3 promo/v2/num_accent.py        # 候補を num/ に作る
  python3 promo/v2/num_accent.py s2     # 選んだものを vo/n_scale.wav に入れる
"""
import json, shutil, sys, pathlib
sys.path.insert(0, '/Users/amano/dev/okotozuke-ads')
import numpy as np, parselmouth, soundfile as sf
from okoads.intonation.psola import pitch, interval_st, psola_points, psola_array, match_energy, splice

V = pathlib.Path(__file__).parent
ORIG, LIVE = V/'vo'/'n_scale.orig.wav', V/'vo'/'n_scale.wav'
if not ORIG.exists(): shutil.copy2(LIVE, ORIG)
REC = json.loads((V/'vo'/'lines'/'n_scale.json').read_text(encoding='utf-8'))
S = REC['sentences'][0]
NUM = S['morae'][0:11]          # ニ セ ン ニ ジュ ー ロ ク ネ ン に

x, sr = sf.read(str(ORIG), dtype='float64')
if x.ndim > 1: x = x.mean(axis=1)
snd = parselmouth.Sound(x, sampling_frequency=sr); t, fz = pitch(snd)

ref = [m for m in S['morae'] if m['after'] is not None and m.get('vowel_t0') is not None]
best, err = None, 1e9
for off in np.arange(0.0, max(0.1, len(x)/sr - 0.5), 0.005):
    got = [interval_st(t, fz, m['vowel_t0']+off, m['vowel_t1']+off) for m in ref]
    if any(g is None for g in got): continue
    e = float(np.mean([abs(g-m['after']) for g, m in zip(got, ref)]))
    if e < err: err, best = e, float(off)
assert best is not None and err < 0.5, f'文の頭が特定できない（{err:.2f}半音）'
print('ずれ %.3f 秒（検算 %.2f 半音）' % (best, err))

TOP = 21.5
#            ニ    セ    ン    ニ   ジュ   ー    ロ    ク    ネ    ン    に
SETS = {
 's1': ('山を1つに、「に」は浅く',
        [17.5, TOP, TOP-.2, TOP-.5, TOP-.7, TOP-1.0, TOP-1.2, TOP-1.0, TOP-.8, TOP-2.0, TOP-4.5]),
 's2': ('山を1つに、「に」は普通に下げる',
        [17.5, TOP, TOP-.2, TOP-.5, TOP-.7, TOP-1.0, TOP-1.2, TOP-1.0, TOP-.8, TOP-2.0, TOP-6.5]),
 's3': ('ゆるやかに下っていく',
        [17.5, TOP, TOP-.5, TOP-1.0, TOP-1.5, TOP-2.0, TOP-2.5, TOP-2.5, TOP-2.5, TOP-3.5, TOP-6.0]),
}
OUT = V/'num'; OUT.mkdir(exist_ok=True)
pick = sys.argv[1] if len(sys.argv) > 1 else None
for key, (note, tgt) in SETS.items():
    rows, deltas = [], []
    for m, want in zip(NUM, tgt):
        if m['after'] is None or m.get('vowel_t0') is None: continue
        rows.append({**m, 'vowel_t0': m['vowel_t0']+best, 'vowel_t1': m['vowel_t1']+best})
        deltas.append(want - m['after'])
    pts = psola_points(rows, deltas, anchor='plateau')
    y = match_energy(x, psola_array(snd, pts), sr)
    out, share = splice(x, y, sr, pts, y=y, snd=snd)
    sf.write(str(OUT/f'{key}.wav'), out, sr)
    print('%s %-28s 動かす量 %s' % (key, note, ' '.join('%+.1f' % d for d in deltas)))
    if pick == key: sf.write(str(LIVE), out, sr); print('   → vo/n_scale.wav に入れました')
