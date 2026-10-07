# Compares the pictures shots-pod.mjs took of two builds: <dir>/<before>-<spot>.png against <dir>/<after>-<spot>.png.
# For each spot it prints the mean difference per channel (percent of full scale) and the share of pixels that differ by more
# than THRESHOLD levels in any channel, writes <after>-<spot>-diff.png (changed pixels in red over the dimmed picture),
# and exits 1 when a spot is over MEAN_MAX or SHARE_MAX. Run: python3 verify/pod-diff.py <dir> [before] [after]
import sys
from pathlib import Path

import numpy as np
from PIL import Image

THRESHOLD = 24
MEAN_MAX = 1.5
SHARE_MAX = 5.0

folder = Path(sys.argv[1])
before = sys.argv[2] if len(sys.argv) > 2 else 'before'
after = sys.argv[3] if len(sys.argv) > 3 else 'after'
worst_mean = worst_share = 0.0
bad = []
for old in sorted(folder.glob(f'{before}-*.png')):
    spot = old.name[len(before) + 1:-4]
    new = folder / f'{after}-{spot}.png'
    if not new.exists():
        bad.append(f'{spot}: no {after} picture')
        continue
    a = np.asarray(Image.open(old).convert('RGB'), dtype=np.int16)
    b = np.asarray(Image.open(new).convert('RGB'), dtype=np.int16)
    delta = np.abs(a - b)
    mean = delta.mean() / 255 * 100
    changed = delta.max(axis=2) > THRESHOLD
    share = changed.mean() * 100
    heat = (b * 0.35).astype(np.uint8)
    heat[changed] = [255, 40, 40]
    Image.fromarray(heat).save(folder / f'{after}-{spot}-diff.png')
    worst_mean = max(worst_mean, mean)
    worst_share = max(worst_share, share)
    print(f'{spot:28s} mean {mean:5.2f}%  pixels over {THRESHOLD}: {share:5.2f}%')
    if mean > MEAN_MAX or share > SHARE_MAX:
        bad.append(f'{spot}: mean {mean:.2f}%, changed {share:.2f}%')
print(f'worst: mean {worst_mean:.2f}% (limit {MEAN_MAX}), changed pixels {worst_share:.2f}% (limit {SHARE_MAX})')
if bad:
    print('OVER THE LIMIT:', *bad, sep='\n  ')
    sys.exit(1)
