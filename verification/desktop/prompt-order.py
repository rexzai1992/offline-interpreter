import json, sys, time, urllib.request
_src = open('matrix.py').read()
_ns = {}
exec(_src[_src.index('LANGS='):_src.index('def prompt')], _ns)
DIALOGS, REPLIES, LANGS = _ns['DIALOGS'], _ns['REPLIES'], _ns['LANGS']
URL = "http://127.0.0.1:8082/v1/chat/completions"
STYLE = "Note that the translation style must strictly conform to [natural everyday spoken conversation, same tone and politeness as the speaker]. Only output the translated result without any additional explanation."

def current(text, tgt, hist):
    bg = ""
    if hist:
        bg = "[Background Information]\nA spoken conversation between two people. Previous turns:\n" + "\n".join(f"Speaker {s} ({l}): {t}" for s, l, t in hist) + "\n\n"
    return f"{bg}Please translate the following text into {tgt}. {STYLE}\n\n[Source Text]\n{text}"

def reordered(text, tgt, hist):
    bg = ""
    if hist:
        bg = "[Background Information]\nA spoken conversation between two people. Previous turns:\n" + "\n".join(f"Speaker {s} ({l}): {t}" for s, l, t in hist) + "\n\n"
    return f"{STYLE}\n\n{bg}Please translate the following text into {tgt}.\n\n[Source Text]\n{text}"

def chat(content):
    body = {"messages": [{"role": "user", "content": content}], "temperature": 0.7, "top_p": 0.6, "top_k": 20, "repeat_penalty": 1.05, "max_tokens": 200, "cache_prompt": True, "seed": 7}
    req = urllib.request.Request(URL, data=json.dumps(body).encode(), headers={"Content-Type": "application/json"})
    d = json.load(urllib.request.urlopen(req, timeout=120))
    tm = d.get("timings", {})
    return d["choices"][0]["message"]["content"].strip(), tm.get("prompt_n"), tm.get("cache_n")

PAIRS = [("en", "ja"), ("en", "ms"), ("zh-Hans", "en"), ("tl", "en"), ("ms", "zh-Hant"), ("ja", "tl"), ("zh-Hant", "ja"), ("tl", "ms")]
totals = {}
rows = []
for name, build in (("current", current), ("reordered", reordered)):
    new_tokens = 0
    for a, b in PAIRS:
        hist = []
        for i, line in enumerate(DIALOGS[a]):
            out, pn, cn = chat(build(line, LANGS[b], hist))
            new_tokens += pn or 0
            rows.append((name, a, b, line, out, pn, cn))
            hist.append(("A", LANGS[a], line))
            rep = REPLIES[b][i]
            out2, pn2, cn2 = chat(build(rep, LANGS[a], hist))
            new_tokens += pn2 or 0
            rows.append((name, b, a, rep, out2, pn2, cn2))
            hist.append(("B", LANGS[b], rep))
    totals[name] = new_tokens
json.dump(rows, open("reorder_results.json", "w"), ensure_ascii=False, indent=1)
print("uncached prompt tokens over", len(rows) // 2, "requests:", totals)
by = {}
for name, s, t, src, out, pn, cn in rows:
    by.setdefault((s, t, src), {})[name] = (out, pn)
for (s, t, src), v in by.items():
    c, r = v.get("current"), v.get("reordered")
    flag = "" if c[0] == r[0] else "  <diff>"
    print(f"{LANGS[s]}->{LANGS[t]} | {src}\n   cur ({c[1]:>3} new): {c[0]}\n   new ({r[1]:>3} new): {r[0]}{flag}")
