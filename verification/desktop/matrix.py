import json, sys, itertools, time
sys.path.insert(0,'.')
from tr import chat
LANGS={"en":"English","ms":"Malay","ja":"Japanese","zh-Hans":"Chinese","zh-Hant":"Traditional Chinese","tl":"Filipino"}
# one short dialogue per source language: (speaker, text). Speaker A speaks the source language; B replies in target language (B's lines given in English for context-building simplicity, we translate only A lines)
DIALOGS={
 "en":["Hi there! I'm Sarah. Is this seat taken?","Oh cool, no worries. Hey, do you know if the last bus leaves at eleven or at midnight?","Ugh, that's a bummer. Could you tell your friend Ahmad I said thanks for the tip?"],
 "ms":["Hai, saya Aiman. Boleh tolong tak?","Saya nak cari kedai mamak yang buka lewat malam. Yang tadi tu dah tutup lah.","Okay, terima kasih banyak-banyak. Nanti saya bagitahu Siti kita jumpa dia kat sana pukul sepuluh."],
 "ja":["すみません、田中と申します。ちょっといいですか？","この近くに夜遅くまでやってるラーメン屋さんってありますか？さっきの店はもう閉まってて。","助かります！じゃあ、佐藤さんにはそこで十時に待ち合わせって伝えておきますね。"],
 "zh-Hans":["你好，我叫小李。打扰一下可以吗？","这附近有没有开到很晚的小吃店？刚才那家已经关门了。","太好了，谢谢你！那我跟王姐说我们十点在那儿碰头。"],
 "zh-Hant":["你好，我是阿明。請問一下可以嗎？","這附近有沒有開到很晚的小吃店？剛剛那家已經關了。","太好了，謝謝你！那我跟王姐說我們十點在那裡碰面。"],
 "tl":["Hi, ako si Marco. Pwede bang magtanong?","May alam ka bang karinderya dito na bukas hanggang gabi? Sarado na yung kanina.","Salamat ha! Sasabihin ko kay Ate Liza na magkita tayo doon ng alas diyes."],
}
REPLIES={"en":["Nope, go ahead.","It leaves at midnight, I think.","Sure, I'll tell him."],
 "ms":["Tak, duduklah.","Rasanya pukul dua belas.","Boleh, saya bagitahu dia."],
 "ja":["どうぞ。","たぶん十二時だと思います。","はい、伝えておきます。"],
 "zh-Hans":["没有，请坐。","我想是十二点。","好的，我会告诉他。"],
 "zh-Hant":["沒有，請坐。","我想是十二點。","好的，我會告訴他。"],
 "tl":["Hindi, umupo ka lang.","Alas dose yata.","Sige, sasabihin ko sa kanya."]}
def prompt(text,tgt,hist):
    bg=""
    if hist:
        bg="[Background Information]\nA spoken conversation between two people. Previous turns:\n"+"\n".join(f"{spk} ({lang}): {txt}" for spk,lang,txt in hist)+"\n\n"
    return f"{bg}Please translate the following text into {tgt}. Note that the translation style must strictly conform to [natural everyday spoken conversation, same tone and politeness as the speaker]. Only output the translated result without any additional explanation.\n\n[Source Text]\n{text}"
out=[]
for src,tgt in itertools.permutations(LANGS.keys(),2):
    hist=[]; print(f"\n##### {LANGS[src]} -> {LANGS[tgt]}")
    for i,line in enumerate(DIALOGS[src]):
        tr,dt=chat(prompt(line,LANGS[tgt],hist))
        print(f"  A: {line}\n   -> {tr!r}  ({dt:.2f}s)")
        hist.append(("Speaker A",LANGS[src],line))
        hist.append(("Speaker B",LANGS[tgt],REPLIES[tgt][i]))
        out.append({"src":src,"tgt":tgt,"turn":i,"text":line,"translation":tr,"secs":round(dt,2)})
json.dump(out,open("matrix_results.json","w"),ensure_ascii=False,indent=1)
