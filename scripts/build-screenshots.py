#!/usr/bin/env python3
"""Build the catalog screenshots in assets/screenshots/ from the prints in docs/images/.

Needs Pillow (`pip install Pillow`). Run from anywhere: `python scripts/build-screenshots.py`.
Uses a system sans-serif font: the directory refuses TTF/OTF files in the package.
"""
from pathlib import Path

from PIL import Image, ImageDraw, ImageFilter, ImageFont

ROOT = Path(__file__).resolve().parent.parent
SRC = ROOT / "docs" / "images"
OUT = ROOT / "assets" / "screenshots"

W, H = 1280, 800
# Median colors of the left and right edges of assets/cover.png.
BG_LEFT = (0x04, 0x2E, 0x4E)
BG_RIGHT = (0x00, 0x3E, 0x49)
TITLE_COLOR = (255, 255, 255)
SUBTITLE_COLOR = (0xB8, 0xD4, 0xE3)
TITLE_SIZE = 44
SUBTITLE_SIZE = 24
MARGIN = 64
RADIUS = 12

BOLD_FONTS = [
    "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
    "/usr/share/fonts/TTF/DejaVuSans-Bold.ttf",
    "/Library/Fonts/Arial Bold.ttf",
    "/System/Library/Fonts/Supplemental/Arial Bold.ttf",
    "C:/Windows/Fonts/segoeuib.ttf",
    "C:/Windows/Fonts/arialbd.ttf",
]
REGULAR_FONTS = [
    "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
    "/usr/share/fonts/TTF/DejaVuSans.ttf",
    "/Library/Fonts/Arial.ttf",
    "/System/Library/Fonts/Supplemental/Arial.ttf",
    "C:/Windows/Fonts/segoeui.ttf",
    "C:/Windows/Fonts/arial.ttf",
]


def load_font(candidates, size):
    for path in candidates:
        if Path(path).exists():
            return ImageFont.truetype(path, size)
    raise SystemExit(f"No sans-serif font found; tried: {', '.join(candidates)}")


TITLE_FONT = load_font(BOLD_FONTS, TITLE_SIZE)
SUBTITLE_FONT = load_font(REGULAR_FONTS, SUBTITLE_SIZE)


def background():
    # Horizontal gradient, like the cover.
    row = Image.new("RGB", (W, 1))
    for x in range(W):
        t = x / (W - 1)
        row.putpixel((x, 0), tuple(round(a + (b - a) * t) for a, b in zip(BG_LEFT, BG_RIGHT)))
    return row.resize((W, H))


def load_print(name, max_height):
    """Open a print and shrink it (never enlarge) to fit max_height."""
    im = Image.open(SRC / name).convert("RGB")
    if im.height > max_height:
        scale = max_height / im.height
        im = im.resize((round(im.width * scale), max_height), Image.LANCZOS)
    return im


def paste_print(canvas, im, x, y):
    """Paste im at (x, y) with rounded corners and a soft shadow."""
    mask = Image.new("L", im.size, 0)
    ImageDraw.Draw(mask).rounded_rectangle((0, 0, im.width - 1, im.height - 1), RADIUS, fill=255)

    blur, offset = 16, 8
    shadow = Image.new("L", (im.width + 4 * blur, im.height + 4 * blur), 0)
    shadow.paste(110, (2 * blur, 2 * blur), mask)
    shadow = shadow.filter(ImageFilter.GaussianBlur(blur))
    canvas.paste((0, 0, 0), (x - 2 * blur, y - 2 * blur + offset), shadow)

    canvas.paste(im, (x, y), mask)


def wrap(text, font, max_width):
    lines, line = [], ""
    for word in text.split():
        candidate = f"{line} {word}".strip()
        if line and font.getlength(candidate) > max_width:
            lines.append(line)
            line = word
        else:
            line = candidate
    lines.append(line)
    return lines


def caption_block(title, subtitle, max_width):
    """Wrapped lines as (text, font, color, line_height), and the total height."""
    rows = [(t, TITLE_FONT, TITLE_COLOR, round(TITLE_SIZE * 1.2)) for t in wrap(title, TITLE_FONT, max_width)]
    rows.append(None)  # gap between title and subtitle
    rows += [(t, SUBTITLE_FONT, SUBTITLE_COLOR, round(SUBTITLE_SIZE * 1.4)) for t in wrap(subtitle, SUBTITLE_FONT, max_width)]
    gap = 12
    height = sum(r[3] if r else gap for r in rows)
    return rows, height, gap


def draw_caption(canvas, title, subtitle, x, y, max_width, center=False):
    """Draw the caption with its top at y; returns the bottom y."""
    draw = ImageDraw.Draw(canvas)
    rows, _, gap = caption_block(title, subtitle, max_width)
    for row in rows:
        if row is None:
            y += gap
            continue
        text, font, color, line_height = row
        tx = x + (max_width - font.getlength(text)) / 2 if center else x
        draw.text((tx, y), text, font=font, fill=color)
        y += line_height
    return y


def side_layout(name, print_file, max_height, title, subtitle):
    """Print on the right, caption on the left, both centered vertically."""
    canvas = background()
    im = load_print(print_file, max_height)
    x = W - MARGIN - im.width
    paste_print(canvas, im, x, (H - im.height) // 2)

    text_width = x - 2 * MARGIN
    _, height, _ = caption_block(title, subtitle, text_width)
    draw_caption(canvas, title, subtitle, MARGIN, (H - height) // 2, text_width)
    save(canvas, name)


def top_layout(name, print_files, title, subtitle):
    """Caption centered at the top, prints side by side below it."""
    canvas = background()
    top, bottom, gap = 28, 28, 40
    text_bottom = draw_caption(canvas, title, subtitle, MARGIN, top, W - 2 * MARGIN, center=True)
    prints_top = text_bottom + 24
    prints = [load_print(f, H - bottom - prints_top) for f in print_files]

    x = (W - sum(p.width for p in prints) - gap * (len(prints) - 1)) // 2
    for p in prints:
        paste_print(canvas, p, x, prints_top)
        x += p.width + gap
    save(canvas, name)


def save(canvas, name):
    OUT.mkdir(parents=True, exist_ok=True)
    canvas.save(OUT / name, optimize=True)
    print(f"{OUT / name}  {canvas.size[0]}x{canvas.size[1]}  {(OUT / name).stat().st_size // 1024} KB")


side_layout(
    "01-setup.png",
    "setup-card.png",
    H - 2 * MARGIN,
    "One bridge per bot",
    "Each Telegram bot pairs with one Orca bot — its own token, access and settings.",
)
top_layout(
    "02-editor.png",
    ["bridge-editor.png", "bridge-editor-groups.png"],
    "Set up in one panel",
    "Connection, who can talk, groups and features.",
)
side_layout(
    "03-roles.png",
    "bridge-roles.png",
    760,
    "Roles for people you let in",
    "Choose what each person or group may do, plus an extra prompt for the Orca bot.",
)
