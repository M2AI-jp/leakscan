"""CTAの行の「リークスキャン」を平板（ほぼ下げない）に描き換える。

VOICEPEAK にはアクセントを指定する口がないので、できた音声の音程を直接動かす。
長さは変えない（PSOLA。おことづけの広告工場から借りる。あちらには書き込まない）。

注意：lines/<id>.json の拍の時刻は「文ごとに0から」で、つないだwavの時刻ではない。
文の頭のずれを総当たりで割り出し、記録ずみの高さと一致するか検算してから使う。
ここを間違えると、別の文を加工してしまう（一度やった）。

  python3 promo/v2/cta_accent.py        # 3通りを cta/ に作る
  python3 promo/v2/cta_accent.py w2     # 選んだものを vo/n_cta.wav に入れる
"""
import json, shutil, sys, pathlib
sys.path.insert(0, '/Users/amano/dev/okotozuke-ads')
import numpy as np, parselmouth, soundfile as sf
from okoads.intonation.psola import pitch, interval_st, psola_points, psola_array, match_energy, splice

V = pathlib.Path(__file__).parent
ORIG, LIVE = V / 'vo' / 'n_cta.orig.wav', V / 'vo' / 'n_cta.wav'
if not ORIG.exists(): shutil.copy2(LIVE, ORIG)

REC = json.loads((V / 'vo' / 'lines' / 'n_cta.json').read_text(encoding='utf-8'))
SI = next(i for i, s in enumerate(REC['sentences']) if 'リークスキャン' in s['text'])
S = REC['sentences'][SI]

x, sr = sf.read(str(ORIG), dtype='float64')
if x.ndim > 1: x = x.mean(axis=1)
snd = parselmouth.Sound(x, sampling_frequency=sr)
t, fz = pitch(snd)

# --- 文の頭のずれを割り出す（記録ずみの高さに一番合う位置） ---
ref = [m for m in S['morae'] if m['after'] is not None and m.get('vowel_t0') is not None]
best, err = None, 1e9
for off in np.arange(0.0, max(0.1, len(x)/sr - 0.5), 0.005):
    got = [interval_st(t, fz, m['vowel_t0'] + off, m['vowel_t1'] + off) for m in ref]
    if any(g is None for g in got): continue
    e = float(np.mean([abs(g - m['after']) for g, m in zip(got, ref)]))
    if e < err: err, best = e, float(off)
assert best is not None and err < 0.5, f'文の頭が特定できない（ずれ {err:.2f} 半音）'
print('文%d のずれ %.3f 秒（検算 %.2f 半音）' % (SI, best, err))

NAME = [m for m in S['morae'] if m['token_text'] == 'リークスキャン']
WA = [m for m in S['morae'] if m['token_text'] == 'は']
H = max(m['after'] for m in NAME if m['after'] is not None)

NAME_OFF = [-3.5, 0.0, 0.0, None, -0.3, -0.8]        # リ ー ク ス キャ ン（聞き比べで選んだ「ほぼ平板」）
WA_OFF = {'w1': (-1.5, 'は も高いまま（きれいな平板）'),
          'w2': (-4.5, 'は を半分だけ持ち上げる'),
          'w3': (None, 'は はそのまま（語だけ平らに）')}

OUT = V / 'cta'; OUT.mkdir(exist_ok=True)
pick = sys.argv[1] if len(sys.argv) > 1 else None
for key, (wa, note) in WA_OFF.items():
    rows, deltas = [], []
    for m, o in list(zip(NAME, NAME_OFF)) + ([(m, wa) for m in WA] if wa is not None else []):
        if o is None or m['after'] is None or m.get('vowel_t0') is None: continue
        rows.append({**m, 'vowel_t0': m['vowel_t0'] + best, 'vowel_t1': m['vowel_t1'] + best})
        deltas.append((H + o) - m['after'])
    pts = psola_points(rows, deltas, anchor='plateau')
    y = match_energy(x, psola_array(snd, pts), sr)
    out, share = splice(x, y, sr, pts, y=y, snd=snd)
    sf.write(str(OUT / f'{key}.wav'), out, sr)
    print('%s %-26s 動かした量 %s' % (key, note, ' '.join('%+.1f' % d for d in deltas)))
    if pick == key:
        sf.write(str(LIVE), out, sr); print('   → vo/n_cta.wav に入れました')
