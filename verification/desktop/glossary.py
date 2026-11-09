import json, re, urllib.request
URL = "http://127.0.0.1:8082/v1/chat/completions"
STYLE = "Note that the translation style must strictly conform to [natural everyday spoken conversation, same tone and politeness as the speaker]. Only output the translated result without any additional explanation."
HOURS = {'una':1,'dos':2,'tres':3,'kuwatro':4,'kwatro':4,'kuatro':4,'singko':5,'sinko':5,'sais':6,'siyete':7,'syete':7,'otso':8,'nuwebe':9,'diyes':10,'dyes':10,'onse':11,'dose':12}
def fmt(n, half, tgt):
    m = ':30' if half else ''
    return {'English': f"{n}{m or ''} o'clock" if not half else f"{n}:30",
            'Japanese': f"{n}時" + ('半' if half else ''),
            'Chinese': f"{n}点" + ('半' if half else ''),
            'Traditional Chinese': f"{n}點" + ('半' if half else ''),
            'Malay': f"pukul {n}" + (' setengah' if half else ''),
            'Filipino': None}[tgt]
def glossary(text, tgt):
    out = []
    for m in re.finditer(r"\b(ala|alas)[\s-]+(" + "|".join(HOURS) + r")(\s+y\s+medya)?\b", text, re.I):
        n = HOURS[m.group(2).lower()]; t = fmt(n, bool(m.group(3)), tgt)
        if t: out.append(f"{m.group(0)} translates to {t}")
    return out
def prompt(text, tgt, hist, use_gloss):
    bg = ""
    if hist:
        bg = "[Background Information]\nA spoken conversation between two people. Previous turns:\n" + "\n".join(f"Speaker {s} ({l}): {t}" for s, l, t in hist) + "\n\n"
    g = glossary(text, tgt) if use_gloss else []
    ref = ("Reference the following translations:\n" + "\n".join(g) + "\n\n") if g else ""
    return f"{STYLE}\n\n{bg}{ref}Please translate the following text into {tgt}.\n\n[Source Text]\n{text}"
def chat(c):
    b = {"messages": [{"role": "user", "content": c}], "temperature": 0.7, "top_p": 0.6, "top_k": 20, "repeat_penalty": 1.05, "max_tokens": 200, "seed": 11}
    r = urllib.request.Request(URL, data=json.dumps(b).encode(), headers={"Content-Type": "application/json"})
    return json.load(urllib.request.urlopen(r, timeout=120))["choices"][0]["message"]["content"].strip()
cases = [
  ("Salamat ha! Sasabihin ko kay Ate Liza na magkita tayo doon ng alas diyes.", [("A","Filipino","May alam ka bang karinderya dito na bukas hanggang gabi?")]),
  ("Alas dose yata.", [("A","Japanese","最終バスは何時ですか？")]),
  ("Kita tayo bukas ng alas tres y medya sa harap ng mall.", []),
  ("Ala una na, kain na tayo.", []),
]
for text, hist in cases:
    for tgt in ["English", "Japanese", "Chinese", "Traditional Chinese", "Malay"]:
        h = [(s, l, t) for s, l, t in hist]
        a = chat(prompt(text, tgt, h, False)); b = chat(prompt(text, tgt, h, True))
        print(f"{tgt:20} | {text}\n   without: {a}\n   with   : {b}   {glossary(text, tgt)}")
