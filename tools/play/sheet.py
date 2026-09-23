#!/usr/bin/env python3
"""A contact sheet: every PNG in a folder, in name order, on one grid.

    python3 tools/play/sheet.py <stills-dir> <out.png> [columns]

`film.mjs` calls it with one still per game-hour, so a two-day film makes
a sheet of 48, eight across -- three rows a day.  Each tile is captioned
with its file name, which is the game-hour.
"""
import sys
from pathlib import Path
from PIL import Image, ImageDraw

src, out = Path(sys.argv[1]), Path(sys.argv[2])
cols = int(sys.argv[3]) if len(sys.argv) > 3 else 8
files = sorted(src.glob('*.png'))
if not files:
    sys.exit('no stills in ' + str(src))
tw = 320
first = Image.open(files[0])
th = round(tw * first.height / first.width)
rows = (len(files) + cols - 1) // cols
sheet = Image.new('RGB', (cols * tw, rows * th), 'black')
draw = ImageDraw.Draw(sheet)
for i, f in enumerate(files):
    im = Image.open(f).convert('RGB').resize((tw, th), Image.LANCZOS)
    x, y = (i % cols) * tw, (i // cols) * th
    sheet.paste(im, (x, y))
    draw.text((x + 6, y + 4), f.stem, fill='white')
sheet.save(out)
print(out, len(files), 'tiles')
