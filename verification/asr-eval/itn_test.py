import json, subprocess, sys, wave, numpy as np, sherpa_onnx
S = sys.argv[1]
MODEL = f'{S}/models/sensevoice2024'
def rec(itn):
    return sherpa_onnx.OfflineRecognizer.from_sense_voice(model=f'{MODEL}/model.int8.onnx', tokens=f'{MODEL}/tokens.txt', num_threads=4, use_itn=itn, language='auto')
R = {True: rec(True), False: rec(False)}
def run(pcm, lang_hint=''):
    out = {}
    for itn, r in R.items():
        st = r.create_stream(); st.accept_waveform(16000, pcm); r.decode_stream(st); out[itn] = st.result.text
    return out
def load(path, a=None, b=None):
    w = wave.open(path); x = np.frombuffer(w.readframes(w.getnframes()), dtype=np.int16).astype(np.float32) / 32768
    return x[a:b] if a is not None else x
sents = [('Samantha', 'en', 'My flight is at seven forty five tomorrow morning from gate twenty three.'),
         ('Samantha', 'en', 'It costs three thousand five hundred yen.'),
         ('Samantha', 'en', 'Please call me at nine thirty.'),
         ('Samantha', 'en', 'The room number is twelve oh five.'),
         ('Kyoko', 'ja', '三千円です。'), ('Kyoko', 'ja', '電車は十時十五分に出ます。'), ('Kyoko', 'ja', '二千五百円になります。'), ('Kyoko', 'ja', 'お部屋は三百五号室です。'),
         ('Tingting', 'zh', '一共是三百五十块。'), ('Tingting', 'zh', '火车十点十五分出发。'), ('Tingting', 'zh', '我的房间是三零五号。')]
print('== Mac voices (clean audio)')
for i, (v, lang, t) in enumerate(sents):
    a, w = f'{S}/itn/s{i}.aiff', f'{S}/itn/s{i}.wav'
    subprocess.run(['say', '-v', v, '-o', a, t]); subprocess.run(['ffmpeg', '-loglevel', 'error', '-y', '-i', a, '-ar', '16000', '-ac', '1', w])
    o = run(load(w))
    print(f'  said: {t}\n    ITN on : {o[True]}\n    ITN off: {o[False]}')
print('== Phone microphone recordings')
for name in ['s5_numbers_names', 's4_handsfree_dialogue', 's15_en_ja_tap_mixed']:
    try: cuts = json.load(open(f'{S}/cap_{name}.json'))['cuts']
    except Exception: continue
    for c in cuts:
        if c['dropped']: continue
        o = run(load(f'{S}/cap_{name}.wav', c['from'], c['at']))
        if any(ch.isdigit() for ch in o[True] + o[False]) or '千' in o[False] or '百' in o[False]:
            print(f'  {name}:\n    ITN on : {o[True]}\n    ITN off: {o[False]}')
