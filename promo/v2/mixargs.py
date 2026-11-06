"""cues.json から、ナレーションを時刻どおりに並べる ffmpeg の引数を作る。
   build.sh から呼ぶ。  使い方: python3 promo/v2/mixargs.py cues.json promo/v2"""
import json, shlex, sys

c = json.load(open(sys.argv[1])); V = sys.argv[2]
ins, fc, mix = [], [], ''
for i, l in enumerate(c['lines']):
    ins += ['-i', f"{V}/vo/{l['id']}.wav"]
    ms = int(round(l['at'] * 1000))
    # 単声なので、両チャンネルに同じ遅れを入れてから広げる
    fc.append(f"[{i}:a]aformat=channel_layouts=mono,adelay={ms}|{ms},aformat=channel_layouts=stereo[v{i}];")
    mix += f'[v{i}]'
graph = ''.join(fc) + mix + (
    f"amix=inputs={len(c['lines'])}:normalize=0,apad,atrim=0:{c['dur']},loudnorm=I=-14:TP=-1.5:LRA=11[a]")
print(shlex.join(ins + ['-filter_complex', graph]))
