"""ナレーションの音程を、人の読み上げから学習したモデル（teacher）に決めさせる。

これまで私（Claude）が半音の数字を手で書いていたのが間違いだった。
teacher は「アクセント型を与えると、人間が使う音程を1拍ずつ返す」モデル
（LightGBM / JSUT 749文の女性の読み上げで学習。VOICEPEAK音声は学習に未使用）。

アクセント型は Open JTalk から取り、合っていないものだけ OVERRIDE で直す。
  リークスキャン … 核=4（リークス↓キャン）と判定されるが、平板が正（聞き比べで決定）
  2026年       … 3つの句に割れる。数字はひと続きで読むので1つに統合

  python3 promo/v2/teach.py --dry   # 音程を出して見るだけ
  python3 promo/v2/teach.py         # vo/*.wav を作り直す
"""
import json, re, shutil, sys, pathlib
sys.path.insert(0, '/Users/amano/dev/okotozuke-ads')
import numpy as np, pandas as pd, parselmouth, pyopenjtalk, soundfile as sf
from okoads.intonation import teacher, teacher_features as pf
from okoads.intonation.psola import pitch, interval_st, psola_points, psola_array, match_energy, splice

V = pathlib.Path(__file__).parent
DRY = '--dry' in sys.argv
CAP = 6.0          # 1拍を動かす上限（半音）

# 文ごとの直し。merge=まとめる句の範囲、acc={句番号: 核}
OVERRIDE = {
 'リークスキャンは、クロームの拡張機能です。': {'acc': {0: 0}},                 # 平板
 'リークスキャンは、ジーメールのさしだしにんだけを見て照合します。': {'acc': {0: 0}},
 '2026年に公表された個人情報の漏洩は、のべ6億件を超えます。': {'merge': [(0, 3)], 'acc': {0: 0}},
}

def aps_of(text):
    labs = pyopenjtalk.extract_fullcontext(text)
    out, prev, pause = [], None, True
    for lab in labs:
        ph = re.search(r'-(.+?)\+', lab).group(1)
        if ph in ('sil', 'pau'):
            prev = None; pause = True; continue
        a2 = int(re.search(r'/A:[\-\dx]+\+(\d+|xx)\+', lab).group(1))
        f1 = re.search(r'/F:(\d+|xx)_(\d+|xx)#', lab).group(2)
        if prev is None or a2 < prev:
            out.append({'morae': [], 'acc': int(f1) if f1 != 'xx' else 0,
                        'pause_before': pause, 'rise': 0})
            pause = False
        if not out[-1]['morae'] or a2 != prev:
            out[-1]['morae'].append(ph)
        else:
            out[-1]['morae'][-1] += ph
        prev = a2
    return out

def teach(text):
    """1文ぶんの、拍ごとの音程（半音。話者の中央値を0とする）"""
    aps = aps_of(text)
    ov = OVERRIDE.get(text, {})
    for a, b in ov.get('merge', []):                 # 句をまとめる
        merged = {'morae': [m for ap in aps[a:b] for m in ap['morae']],
                  'acc': aps[a]['acc'], 'pause_before': aps[a]['pause_before'], 'rise': 0}
        aps[a:b] = [merged]
    for i, acc in ov.get('acc', {}).items():         # 核を直す
        if i < len(aps): aps[i]['acc'] = acc
    utt = {'aps': aps, 'question': text.rstrip().endswith(('？', '?'))}
    feats = pf.add_codes(pf.utterance_features(utt))
    parts = pf.particle_flags(text, [f['mora_ph'] for f in feats], pyopenjtalk)
    for f, p in zip(feats, parts): f['is_particle'] = p
    fd = pd.DataFrame(feats)
    pred = teacher.gbm().predict(fd[pf.GBM_FEATURES].astype(float))
    return [m for ap in aps for m in ap['morae']], [float(x) for x in pred]

def sentence_offset(S, t, fz, dur):
    """lines.json の拍の時刻は文ごとに0から。つないだwavの中での頭のずれを割り出す。
       記録ずみの高さと一致するかで検算する（ここを間違えると別の文を加工する）。"""
    ref = [m for m in S['morae'] if m['after'] is not None and m.get('vowel_t0') is not None]
    best, err = None, 1e9
    for off in np.arange(0.0, max(0.1, dur - 0.3), 0.005):
        got = [interval_st(t, fz, m['vowel_t0']+off, m['vowel_t1']+off) for m in ref]
        if any(g is None for g in got): continue
        e = float(np.mean([abs(g-m['after']) for g, m in zip(got, ref)]))
        if e < err: err, best = e, float(off)
    return best, err

IDS = [l['id'] for l in json.loads((V/'lines.json').read_text(encoding='utf-8'))]
WATCH = {'リークスキャン', 'に', '二', '千', '十', '六', '年', '無料'}

for lid in IDS:
    rec = json.loads((V/'vo'/'lines'/f'{lid}.json').read_text(encoding='utf-8'))
    orig, live = V/'vo'/f'{lid}.orig.wav', V/'vo'/f'{lid}.wav'
    if not orig.exists(): shutil.copy2(live, orig)
    x, sr = sf.read(str(orig), dtype='float64')
    if x.ndim > 1: x = x.mean(axis=1)
    snd = parselmouth.Sound(x, sampling_frequency=sr); t, fz = pitch(snd)

    rows, deltas = [], []
    for S in rec['sentences']:
        ph, st = teach(S['text'])
        assert len(ph) == len(S['morae']), f'{lid}: 拍の数が合わない'
        off, err = sentence_offset(S, t, fz, len(x)/sr)
        assert off is not None and err < 0.6, f'{lid}: 文の頭が特定できない（{err:.2f}半音）'
        # 教師は「話者の中央値からの差」。この録音の高さに合わせ直す（形だけ使う）
        pair = [(m, v) for m, v in zip(S['morae'], st) if m['after'] is not None and m.get('vowel_t0') is not None]
        shift = float(np.mean([m['after'] for m, _ in pair]) - np.mean([v for _, v in pair]))
        for m, v in pair:
            d = float(np.clip((v + shift) - m['after'], -CAP, CAP))
            if abs(d) < 0.05: continue
            rows.append({**m, 'vowel_t0': m['vowel_t0']+off, 'vowel_t1': m['vowel_t1']+off})
            deltas.append(d)
        show = [(m['kana'], m['after'], v + shift) for m, v in pair if m['token_text'] in WATCH]
        if show:
            print('%s  %s' % (lid, S['text'][:22]))
            print('    前:', ' '.join('%s%.0f' % (k, a) for k, a, _ in show))
            print('    後:', ' '.join('%s%.0f' % (k, b) for k, _, b in show))
    print('%-8s %d拍を動かす（最大 %.1f 半音）' % (lid, len(rows), max((abs(d) for d in deltas), default=0)))
    if DRY or not rows: continue
    pts = psola_points(rows, deltas, anchor='plateau')
    y = match_energy(x, psola_array(snd, pts), sr)
    out, share = splice(x, y, sr, pts, y=y, snd=snd)
    sf.write(str(live), out, sr)
