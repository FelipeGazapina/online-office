# How much two screenshots differ inside a screen region, for pixels in the hull of the KEEP points and outside the hull
# of the SKIP points. Prints {"mean": percent of full scale per channel, "share": percent of pixels that differ by more than
# 24 levels, "pixels": how many were compared}.
# Run: python3 verify/region-diff.py a.png b.png '[[x,y],...]' ['[[x,y],...]']
import json
import sys

import numpy as np
from PIL import Image, ImageDraw


def hull(points):
    pts = sorted(set(map(tuple, points)))
    if len(pts) < 3:
        return pts

    def cross(o, a, b):
        return (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0])

    lower, upper = [], []
    for p in pts:
        while len(lower) >= 2 and cross(lower[-2], lower[-1], p) <= 0:
            lower.pop()
        lower.append(p)
    for p in reversed(pts):
        while len(upper) >= 2 and cross(upper[-2], upper[-1], p) <= 0:
            upper.pop()
        upper.append(p)
    return lower[:-1] + upper[:-1]


def mask(points, size):
    img = Image.new('L', size, 0)
    ImageDraw.Draw(img).polygon([tuple(p) for p in hull(points)], fill=1)
    return np.asarray(img, dtype=bool)


a = Image.open(sys.argv[1]).convert('RGB')
b = Image.open(sys.argv[2]).convert('RGB')
keep = mask(json.loads(sys.argv[3]), a.size)
if len(sys.argv) > 4:
    keep &= ~mask(json.loads(sys.argv[4]), a.size)
pa = np.asarray(a, dtype=np.int16)[keep]
pb = np.asarray(b, dtype=np.int16)[keep]
delta = np.abs(pa - pb)
print(json.dumps({'mean': round(float(delta.mean() / 255 * 100), 3), 'share': round(float((delta.max(axis=1) > 24).mean() * 100), 3), 'pixels': int(keep.sum())}))
