import json, sys
sys.path.insert(0,'.')
from tr import chat
def p_official(text,tgt,hist):
    if hist:
        bg="\n".join(f"{spk} ({lang}): {txt}" for spk,lang,txt in hist)
        return f"[Background Information]\nA spoken conversation between two people. Previous turns:\n{bg}\n\nPlease translate the following text into {tgt}, taking the provided background information into consideration. Note that you should only output the translated result without any additional explanation.\n\n[Source Text]\n{text}"
    return f"Translate the following text into {tgt}. Note that you should only output the translated result without any additional explanation:\n\n{text}"
def p_style(text,tgt,hist):
    bg=""
    if hist:
        bg="[Background Information]\nA spoken conversation between two people. Previous turns:\n"+"\n".join(f"{spk} ({lang}): {txt}" for spk,lang,txt in hist)+"\n\n"
    return f"{bg}Please translate the following text into {tgt}. Note that the translation style must strictly conform to [natural everyday spoken conversation, same tone and politeness as the speaker]. Only output the translated result without any additional explanation.\n\n[Source Text]\n{text}"
tests=[
  ("Japanese","English","えー、マジで？それはちょっとヤバいね。",[("Speaker A","English","I missed the last train and had to walk two hours home.")]),
  ("Filipino","English","Sige, kita tayo mamaya. Huwag kang male-late ha.",[]),
  ("English","Traditional Chinese","Could you ask her if the room is still available for Friday?",[("Speaker A","Traditional Chinese","我姐姐說她民宿這週末可能還有空房。")]),
  ("English","Japanese","Nah, I'm good, thanks. Maybe next time.",[("Speaker A","Japanese","コーヒーでも飲みに行かない？")]),
  ("Malay","Japanese","Tak apa, saya boleh tunggu. Boleh beritahu dia saya sampai pukul tujuh?",[("Speaker A","Japanese","田中さんは今ちょっと手が離せないみたいです。")]),
  ("Chinese","Malay","那家店太贵了吧，我们换一家呗。",[]),
  ("English","Filipino","Tell him it's fine, I'll pay for it. He doesn't need to worry.",[("Speaker A","Filipino","Si Kuya Ben ay nag-aalala tungkol sa bayad sa hotel.")]),
  ("Japanese","Malay","お手洗いはどちらですか？",[]),
  ("Traditional Chinese","Filipino","你們幾點關門？我可能會晚一點到。",[]),
  ("Filipino","Japanese","Pwede bang makahingi ng tubig? Sobrang init ngayon.",[]),
]
for temp in (0.7,0.3):
    print(f"\n======== temperature {temp} ========")
    for src,tgt,text,hist in tests:
        a,_=chat(p_official(text,tgt,hist),temperature=temp); b,_=chat(p_style(text,tgt,hist),temperature=temp)
        print(f"\n### {src} -> {tgt}: {text}")
        print(f"  official: {a!r}")
        print(f"  style   : {b!r}")
