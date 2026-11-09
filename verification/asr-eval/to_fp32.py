import sys, shutil, os, torch
from transformers import WhisperForConditionalGeneration
src, dst = sys.argv[1], sys.argv[2]
m = WhisperForConditionalGeneration.from_pretrained(src, torch_dtype=torch.float32)
m.save_pretrained(dst, safe_serialization=True)
for f in os.listdir(src):
    if f.endswith('.json') or f.endswith('.txt'):
        if not os.path.exists(os.path.join(dst, f)): shutil.copy(os.path.join(src, f), dst)
print('saved', dst)
