"""ナレーション全行の抑揚をならす。

VOICEPEAK は1文の中で、区切りごとに山を作り直して毎回ほぼ同じ高さまで上げる。
日本語は文の後ろへ行くほど下がっていく（下降）ので、山が何度も立つと訛って聞こえる。

やること：各区切りの山の高さに上限をかけ、後ろの区切りほど低くする。
区切りの中の形（どこで上がってどこで下がるか）はVOICEPEAKのまま動かさない。
つまり「読み方」は変えず、「文全体の傾き」だけ付け直す。

  python3 promo/v2/prosody.py          # vo/*.wav を作り直す（素の音は vo/*.orig.wav に残す）
  python3 promo/v2/prosody.py --dry    # 何をどれだけ動かすか見るだけ
"""
import json, shutil, sys, pathlib
sys.path.insert(0, '/Users/amano/dev/okotozuke-ads')
import numpy as np, parselmouth, soundfile as sf
from okoads.intonation.psola import pitch, interval_st, psola_points, psola_array, match_energy, splice

V = pathlib.Path(__file__).parent
DRY = '--dry' in sys.argv
# 日本語の下降は一定ではなく、後ろへ行くほど緩んで止まる。
# 下げ幅 = RANGE * (1 - exp(-k/TAU))。区切りが多い文でも下がりすぎない。
RANGE = 6.0       # 文の中で下がる総量の上限（半音）
TAU = 2.5         # 緩み方
CAP = 6.0         # 1拍を動かす上限
IDS = [l['id'] for l in json.loads((V/'lines.json').read_text(encoding='utf-8'))]

# 語の中の形を直接決める指定（聞き比べで選んだ形）。ここに書いた拍には下降を重ねない。
FLAT = {'n_cta': {'リークスキャン': [-3.5, 0.0, 0.0, None, -0.3, -0.8]}}

# 区切りをまたいでひと続きにする指定。下げるだけでは山は1つにならないので、
# 山を1回にした形を直接書く（その文の一番高い拍からの差、半音）。
#   2026年に … VOICEPEAKは「にせん／にじゅう／ろくねんに」と山を3回作る
MERGE = {'n_scale': [(0, 11, [-4.0, 0.0, -0.2, -0.5, -0.7, -1.0, -1.2, -1.0, -0.8, -2.0, -4.5])]}

def sentence_offset(S, snd_t, snd_f, dur):
    ref = [m for m in S['morae'] if m['after'] is not None and m.get('vowel_t0') is not None]
    best, err = None, 1e9
    for off in np.arange(0.0, max(0.1, dur - 0.3), 0.005):
        got = [interval_st(snd_t, snd_f, m['vowel_t0']+off, m['vowel_t1']+off) for m in ref]
        if any(g is None for g in got): continue
        e = float(np.mean([abs(g-m['after']) for g, m in zip(got, ref)]))
        if e < err: err, best = e, float(off)
    return best, err

for lid in IDS:
    rec = json.loads((V/'vo'/'lines'/f'{lid}.json').read_text(encoding='utf-8'))
    orig = V/'vo'/f'{lid}.orig.wav'; live = V/'vo'/f'{lid}.wav'
    if not orig.exists(): shutil.copy2(live, orig)
    x, sr = sf.read(str(orig), dtype='float64')
    if x.ndim > 1: x = x.mean(axis=1)
    snd = parselmouth.Sound(x, sampling_frequency=sr); t, fz = pitch(snd)

    rows, deltas, report = [], [], []
    for S in rec['sentences']:
        off, err = sentence_offset(S, t, fz, len(x)/sr)
        assert off is not None and err < 0.6, f'{lid}: 文の頭が特定できない（{err:.2f}半音）'
        ms = S['morae']
        # --- 区切りごとの山 ---
        aps = sorted({m['ap'] for m in ms})
        peak = {a: max((m['after'] for m in ms if m['ap'] == a and m['after'] is not None), default=None)
                for a in aps}
        top = peak[aps[0]]
        shift = {}
        for k, a in enumerate(aps):
            if peak[a] is None: shift[a] = 0.0; continue
            allowed = top - RANGE * (1.0 - np.exp(-k / TAU))
            shift[a] = min(0.0, allowed - peak[a])      # 下げる方向にだけ効かせる
        # --- 語の中を平らにする指定（あれば先に反映） ---
        flat = FLAT.get(lid, {})
        merge = {}
        for a, b, tgt in MERGE.get(lid, []):
            if b <= len(ms):
                H = max((n['after'] for n in ms[a:b] if n['after'] is not None), default=None)
                if H is not None:
                    for n, o in zip(ms[a:b], tgt): merge[id(n)] = H + o
        for m in ms:
            if m['after'] is None or m.get('vowel_t0') is None: continue
            d = shift[m['ap']]
            tok = m['token_text']
            if id(m) in merge:                      # ひと続きにする指定が最優先
                d = merge[id(m)] - m['after']
            elif tok in flat:                       # 語の形の指定。下降は重ねない
                idx = [n for n in ms if n['token_text'] == tok].index(m)
                offv = flat[tok][idx]
                if offv is not None:
                    H = max(n['after'] for n in ms if n['token_text'] == tok and n['after'] is not None)
                    d = (H + offv) - m['after']
            if abs(d) < 0.05: continue
            d = float(np.clip(d, -CAP, CAP))
            rows.append({**m, 'vowel_t0': m['vowel_t0']+off, 'vowel_t1': m['vowel_t1']+off})
            deltas.append(d)
        report.append('   %s  区切り%d  下げ幅 %s' % (
            S['text'][:16], len(aps), ' '.join('%.1f' % shift[a] for a in aps)))

    print('%s  %d拍を動かす（最大 %.1f 半音）' % (lid, len(rows), max((abs(d) for d in deltas), default=0)))
    for r in report: print(r)
    if DRY or not rows: continue
    pts = psola_points(rows, deltas, anchor='plateau')
    y = match_energy(x, psola_array(snd, pts), sr)
    out, share = splice(x, y, sr, pts, y=y, snd=snd)
    sf.write(str(live), out, sr)
