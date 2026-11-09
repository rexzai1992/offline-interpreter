"""WER/CER of whisper.cpp models on a FLEURS subset, decoded like the app (greedy, no fallback)."""
import csv, json, os, random, re, shutil, subprocess, sys, time, unicodedata
S, lang_dir, wlang, n = sys.argv[1], sys.argv[2], sys.argv[3], int(sys.argv[4])
models = json.loads(sys.argv[5])
rows = list(csv.reader(open(f'{lang_dir}/test.tsv', encoding='utf8'), delimiter='\t', quoting=csv.QUOTE_NONE))
rows = [r for r in rows if os.path.exists(f'{lang_dir}/audio/test/{r[1]}')]
sub = random.Random(7).sample(rows, min(n, len(rows)))
work = f'{lang_dir}/eval'
os.makedirs(work, exist_ok=True)
for r in sub:
    dst = f'{work}/{r[1]}'
    if not os.path.exists(dst): shutil.copy(f'{lang_dir}/audio/test/{r[1]}', dst)
refs = {r[1]: r[3] for r in sub}
def norm(t):
    t = unicodedata.normalize('NFKC', t).lower()
    t = re.sub(r"[^\w\s']", ' ', t)
    return ' '.join(t.split())
def lev(a, b):
    prev = list(range(len(b) + 1))
    for i, x in enumerate(a, 1):
        cur = [i]
        for j, y in enumerate(b, 1): cur.append(min(prev[j] + 1, cur[j-1] + 1, prev[j-1] + (x != y)))
        prev = cur
    return prev[-1]
cli = f'{S}/whisper.cpp/build/bin/whisper-cli'
files = [f'{work}/{r[1]}' for r in sub]
audio_s = sum(os.path.getsize(f) - 44 for f in files) / 32000
print(f'{lang_dir.split("/")[-1]}: {len(files)} clips, {audio_s/60:.1f} min of speech')
for name, path in models.items():
    for f in files:
        if os.path.exists(f + '.txt'): os.remove(f + '.txt')
    t0 = time.time()
    cmd = [cli, '-m', path, '-l', wlang, '-bo', '1', '-bs', '1', '-nf', '-otxt', '-np', '-t', '8']
    for f in files: cmd += ['-f', f]
    subprocess.run(cmd, capture_output=True)
    el = time.time() - t0
    we = wn = ce = cn = 0; samples = []
    for f in files:
        hyp = open(f + '.txt', encoding='utf8').read() if os.path.exists(f + '.txt') else ''
        os.replace(f + '.txt', f'{f}.{name}.txt') if os.path.exists(f + '.txt') else None
        ref = norm(refs[os.path.basename(f)]); h = norm(hyp)
        we += lev(ref.split(), h.split()); wn += len(ref.split())
        ce += lev(ref.replace(' ', ''), h.replace(' ', '')); cn += len(ref.replace(' ', ''))
        if len(samples) < 3: samples.append((ref, h))
    print(f'  {name:32s} WER {100*we/wn:5.1f}%  CER {100*ce/cn:5.1f}%  ({el:.0f}s on Mac)')
    for ref, h in samples[:2]: print(f'      ref: {ref[:90]}\n      hyp: {h[:90]}')
