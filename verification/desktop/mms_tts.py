import sys, torch, scipy.io.wavfile as wavfile, numpy as np
from transformers import VitsModel, AutoTokenizer
lang, out, text = sys.argv[1], sys.argv[2], sys.argv[3]
model = VitsModel.from_pretrained(f"facebook/mms-tts-{lang}")
tok = AutoTokenizer.from_pretrained(f"facebook/mms-tts-{lang}")
inputs = tok(text, return_tensors="pt")
with torch.no_grad():
    wav = model(**inputs).waveform[0].numpy()
wavfile.write(out, model.config.sampling_rate, (wav * 32767).astype(np.int16))
print(out, model.config.sampling_rate, len(wav)/model.config.sampling_rate, "s")
