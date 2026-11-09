import json, sys, urllib.request, time
URL="http://127.0.0.1:8081/v1/chat/completions"
def chat(content, max_tokens=256, temperature=0.7):
    body={"messages":[{"role":"user","content":content}],"temperature":temperature,"top_p":0.6,"top_k":20,"repeat_penalty":1.05,"max_tokens":max_tokens}
    req=urllib.request.Request(URL,data=json.dumps(body).encode(),headers={"Content-Type":"application/json"})
    t=time.time()
    d=json.load(urllib.request.urlopen(req,timeout=120))
    return d["choices"][0]["message"]["content"], time.time()-t

def prompt_plain(src_text, target):
    return f"Translate the following text into {target}. Note that you should only output the translated result without any additional explanation:\n\n{src_text}"

def prompt_ctx(src_text, target, history):
    # history: list of (speaker_label, lang_name, text)
    if history:
        bg="\n".join(f"{spk} ({lang}): {txt}" for spk,lang,txt in history)
        return (f"[Background Information]\nThis is a spoken conversation between two people. Previous turns:\n{bg}\n\n"
                f"Please translate the following text into {target}, taking the provided background information into consideration. "
                f"Translate it as natural spoken {target}, keeping the speaker's tone, politeness and intent. Note that you should only output the translated result without any additional explanation.\n\n"
                f"[Source Text]\n{src_text}")
    return (f"Please translate the following text into {target}. "
            f"Translate it as natural spoken {target}, keeping the speaker's tone, politeness and intent. Note that you should only output the translated result without any additional explanation.\n\n{src_text}")

if __name__=="__main__":
    tests=[
      ("English","Japanese","Hey, are you coming to the party tonight or not?",[]),
      ("English","Malay","Nah, I'm good, thanks. Maybe next time.",[]),
      ("Japanese","English","えー、マジで？それはちょっとヤバいね。",[]),
      ("Chinese","English","他说明天不来了。",[("Speaker A","English","Did you hear back from Mr. Tanaka about tomorrow's meeting?")]),
      ("Malay","English","Boleh, tapi dia kena bayar dulu lah.",[("Speaker A","English","Can my cousin Ahmad join the trip too?")]),
      ("Filipino","English","Sige, kita tayo mamaya. Huwag kang male-late ha.",[]),
      ("English","Filipino","Sorry, I'll be a bit late. Can you order for me? Same as last time.",[("Speaker A","Filipino","Nandito na ako sa restaurant. Nasaan ka na?")]),
      ("English","Traditional Chinese","Could you ask her if the room is still available for Friday?",[]),
    ]
    for src,tgt,text,hist in tests:
        a,ta=chat(prompt_plain(text,tgt)); b,tb=chat(prompt_ctx(text,tgt,hist))
        print(f"\n### {src} -> {tgt}: {text}")
        print(f"  plain ({ta:.1f}s): {a!r}")
        print(f"  ctx   ({tb:.1f}s): {b!r}")
