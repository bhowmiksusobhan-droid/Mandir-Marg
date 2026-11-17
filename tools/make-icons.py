"""Generate Mandir Marg app icons (SVG + PNG).

Run from the project root:
    python tools/make-icons.py
"""

from pathlib import Path

from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parent.parent
ICONS = ROOT / "public" / "icons"
ICONS.mkdir(parents=True, exist_ok=True)

SIZE = 1024
MAROON_TOP = (122, 37, 37)
MAROON_BOTTOM = (79, 20, 20)
MAROON = (103, 28, 28)
GOLD = (217, 164, 65)
GOLD_LIGHT = (240, 201, 121)
CREAM = (248, 234, 208)
CREAM_DARK = (232, 211, 168)


def rounded_rect(draw, box, radius, fill):
    draw.rounded_rectangle(box, radius=radius, fill=fill)


def draw_icon(maskable: bool) -> Image.Image:
    img = Image.new("RGBA", (SIZE, SIZE), (0, 0, 0, 0))

    # Vertical gradient background.
    bg = Image.new("RGB", (SIZE, SIZE))
    bg_draw = ImageDraw.Draw(bg)
    for y in range(SIZE):
        t = y / (SIZE - 1)
        color = tuple(
            round(MAROON_TOP[i] + (MAROON_BOTTOM[i] - MAROON_TOP[i]) * t)
            for i in range(3)
        )
        bg_draw.line([(0, y), (SIZE, y)], fill=color)
    img.paste(bg, (0, 0))

    # Subtle concentric rings behind the main emblem.
    decor = ImageDraw.Draw(img)
    for radius, color in ((470, (128, 43, 43)), (455, (128, 43, 43))):
        decor.ellipse(
            (SIZE // 2 - radius, SIZE // 2 - radius, SIZE // 2 + radius, SIZE // 2 + radius),
            outline=color,
            width=3,
        )

    d = ImageDraw.Draw(img)

    # Main gold ring.
    d.ellipse((64, 64, SIZE - 64, SIZE - 64), outline=GOLD, width=10)

    # Diyas (lamps) either side of the temple.
    for cx in (286, 738):
        d.ellipse((cx - 22, 752, cx + 22, 790), fill=GOLD)
        d.ellipse((cx - 9, 730, cx + 9, 758), fill=GOLD_LIGHT)

    # Base platform and steps.
    rounded_rect(d, (310, 786, 714, 812), 8, CREAM_DARK)
    rounded_rect(d, (334, 700, 690, 792), 12, CREAM)

    # Second tier.
    rounded_rect(d, (374, 634, 650, 700), 6, CREAM)

    # Stepped shikhara (main spire).
    d.polygon([(410, 638), (614, 638), (586, 574), (438, 574)], fill=CREAM)
    d.polygon([(446, 574), (578, 574), (552, 510), (472, 510)], fill=CREAM)
    d.polygon([(472, 510), (552, 510), (512, 356)], fill=CREAM)

    # Finial staff, ball and flag.
    d.rectangle((505, 268, 519, 362), fill=GOLD)
    d.ellipse((492, 244, 532, 284), fill=GOLD)
    d.polygon([(519, 278), (636, 306), (519, 336)], fill=GOLD)

    # Doorway (arch inside the base).
    d.ellipse((474, 706, 550, 782), fill=MAROON)
    d.rectangle((484, 742, 540, 792), fill=MAROON)
    d.arc((474, 706, 550, 782), 180, 360, fill=GOLD, width=5)
    d.line([(484, 744), (484, 792)], fill=GOLD, width=5)
    d.line([(540, 744), (540, 792)], fill=GOLD, width=5)

    if not maskable:
        # Rounded-square mask for standard icons.
        mask = Image.new("L", (SIZE, SIZE), 0)
        ImageDraw.Draw(mask).rounded_rectangle((0, 0, SIZE, SIZE), radius=220, fill=255)
        img.putalpha(mask)

    return img


def main() -> None:
    icon = draw_icon(maskable=False)
    icon.resize((512, 512), Image.LANCZOS).save(ICONS / "icon-512.png")
    icon.resize((192, 192), Image.LANCZOS).save(ICONS / "icon-192.png")

    maskable = draw_icon(maskable=True)
    maskable.resize((512, 512), Image.LANCZOS).save(ICONS / "icon-maskable-512.png")

    # Framed emblem used as the Open Graph preview.
    og = Image.new("RGB", (1200, 630), (251, 246, 236))
    og_draw = ImageDraw.Draw(og)
    og_draw.rectangle((0, 500, 1200, 630), fill=(103, 28, 28))
    emblem = icon.resize((420, 420), Image.LANCZOS)
    og.paste(emblem, (390, 40), emblem)
    og.save(ICONS / "og-image.png")

    print("Icons written to", ICONS)


if __name__ == "__main__":
    main()
