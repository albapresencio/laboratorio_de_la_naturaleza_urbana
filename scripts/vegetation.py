"""Street-level vegetation segmentation (Green View Index) with Mask2Former Swin-L trained on Cityscapes.

Writes per image <name>-mask.png (vegetation = white) and <name>-overlay.jpg, plus summary.json with pixel
fractions and index.html, a side-by-side report.
usage: python scripts/vegetation.py <image or dir> [...] [--out vegetation_out]
needs: pip install -r requirements-vegetation.txt
"""
import argparse
import html
import json
import os

import numpy as np
import torch
from PIL import Image
from transformers import AutoImageProcessor, Mask2FormerForUniversalSegmentation

MODEL = 'facebook/mask2former-swin-large-cityscapes-semantic'   # 83.3 mIoU on Cityscapes val
VEGETATION, TERRAIN, SKY = 8, 9, 10                             # Cityscapes train ids
IMAGE_EXT = ('.jpg', '.jpeg', '.png', '.webp')


def image_paths(inputs):
    paths = []
    for p in inputs:
        if os.path.isdir(p):
            paths += sorted(os.path.join(p, f) for f in os.listdir(p) if f.lower().endswith(IMAGE_EXT))
        else:
            paths.append(p)
    return paths


class Segmenter:
    def __init__(self):
        self.dev = 'mps' if torch.backends.mps.is_available() else 'cuda' if torch.cuda.is_available() else 'cpu'
        self.proc = AutoImageProcessor.from_pretrained(MODEL)
        self.model = Mask2FormerForUniversalSegmentation.from_pretrained(MODEL).to(self.dev).eval()
        self.labels = self.model.config.id2label

    def __call__(self, img):
        """PIL image -> per-pixel Cityscapes class ids."""
        with torch.no_grad():
            inp = self.proc(images=img, return_tensors='pt').to(self.dev)
            out = self.model(**inp)
        return self.proc.post_process_semantic_segmentation(out, target_sizes=[img.size[::-1]])[0].cpu().numpy()


def overlay(img, veg, ter):
    """Dim the photo; vegetation in green, terrain in yellow."""
    arr = np.asarray(img).astype(np.float32)
    out = arr * 0.45
    out[veg] = arr[veg] * 0.35 + np.array([40, 230, 70]) * 0.65
    out[ter] = arr[ter] * 0.45 + np.array([230, 200, 60]) * 0.55
    return Image.fromarray(out.clip(0, 255).astype(np.uint8))


def write_report(out_dir, sources, summary):
    rows = []
    for name, s in summary['images'].items():
        src = html.escape(os.path.relpath(sources[name], out_dir))
        rows.append(f'<section><h2>{html.escape(name)} <span>vegetation {s["vegetation"]:.1%} · terrain {s["terrain"]:.1%}</span></h2>\n'
                    f'<div class="pair"><img src="{src}"><img src="{html.escape(name)}-overlay.jpg"></div></section>')
    page = ('<!DOCTYPE html><meta charset="utf-8"><title>Vegetation</title>\n'
            '<style>body{font:15px system-ui;background:#111;color:#eee;margin:24px}h2{font-weight:600;font-size:17px}'
            'h2 span{color:#6c6;font-weight:400;margin-left:12px}\n'
            '.pair{display:grid;grid-template-columns:1fr 1fr;gap:12px}img{width:100%;border-radius:6px}section{margin-bottom:36px}</style>\n'
            '<h1>Vegetation segmentation — Mask2Former (Cityscapes)</h1>'
            '<p>Left: original · Right: green = vegetation, yellow = terrain</p>' + '\n'.join(rows))
    with open(os.path.join(out_dir, 'index.html'), 'w') as f:
        f.write(page)


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('inputs', nargs='+')
    ap.add_argument('--out', default='vegetation_out')
    a = ap.parse_args()
    os.makedirs(a.out, exist_ok=True)

    seg_model = Segmenter()
    summary, sources = {'model': MODEL, 'images': {}}, {}
    for path in image_paths(a.inputs):
        img = Image.open(path).convert('RGB')
        seg = seg_model(img)
        n = seg.size
        veg, ter, sky = seg == VEGETATION, seg == TERRAIN, seg == SKY
        counts = np.bincount(seg.ravel(), minlength=len(seg_model.labels))
        name = os.path.splitext(os.path.basename(path))[0]
        sources[name] = path
        s = summary['images'][name] = {
            'vegetation': round(veg.sum() / n, 4),                         # Green View Index (trees, hedges, bushes)
            'terrain': round(ter.sum() / n, 4),                            # grass / soil (horizontal)
            'vegetation_excl_sky': round(veg.sum() / max(1, n - sky.sum()), 4),
            'classes': {seg_model.labels[i]: round(c / n, 4) for i, c in enumerate(counts) if c / n >= 0.005},
        }
        Image.fromarray((veg * 255).astype(np.uint8)).save(os.path.join(a.out, f'{name}-mask.png'))
        overlay(img, veg, ter).save(os.path.join(a.out, f'{name}-overlay.jpg'), quality=90)
        print(f"{name:28s} vegetation {s['vegetation']:6.1%}  terrain {s['terrain']:6.1%}")

    with open(os.path.join(a.out, 'summary.json'), 'w') as f:
        json.dump(summary, f, indent=2, ensure_ascii=False)
    write_report(a.out, sources, summary)


if __name__ == '__main__':
    main()
