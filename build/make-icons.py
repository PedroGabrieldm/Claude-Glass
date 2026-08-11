# Gera os .ico a partir do mesmo sprite pixel-art usado no renderer (renderer/pet.js).
# Desenha cada tamanho nativamente com celula inteira, para o pixel art nao borrar.
from PIL import Image, ImageDraw
from pathlib import Path

SPRITE = [
    '.########.',
    '.########.',
    '##########',
    '###o##o###',
    '##########',
    '.########.',
    '.########.',
    '.#.#..#.#.',
    '.#.#..#.#.',
]

COLS = len(SPRITE[0])
ROWS = len(SPRITE)

PIXEL = (213, 118, 88, 255)      # --pixel: terracota do Claude
EYE = (34, 27, 22, 255)          # --eye
FIRE = (255, 122, 26, 255)       # pet "pegando fogo"
BG = (23, 19, 15, 255)           # fundo do icone do app

ROOT = Path(__file__).resolve().parent.parent
BUILD = ROOT / 'build'    # icone do app: o electron-builder pega daqui
ASSETS = ROOT / 'assets'  # icones de bandeja: precisam ir dentro do pacote
ASSETS.mkdir(exist_ok=True)


def draw_sprite(img, size, body, eye, fill_ratio):
    cell = max(1, int(size * fill_ratio / COLS))
    ox = (size - COLS * cell) // 2
    oy = (size - ROWS * cell) // 2
    d = ImageDraw.Draw(img)
    for r, row in enumerate(SPRITE):
        for c, ch in enumerate(row):
            if ch == '.':
                continue
            x, y = ox + c * cell, oy + r * cell
            d.rectangle([x, y, x + cell - 1, y + cell - 1],
                        fill=eye if ch == 'o' else body)


def rounded_bg(size):
    # supersample so the rounded corner nao fica serrilhado
    s = size * 4
    img = Image.new('RGBA', (s, s), (0, 0, 0, 0))
    ImageDraw.Draw(img).rounded_rectangle([0, 0, s - 1, s - 1],
                                          radius=int(s * 0.22), fill=BG)
    return img.resize((size, size), Image.LANCZOS)


def build(out_dir, name, body, with_bg):
    sizes = [16, 20, 24, 32, 40, 48, 64, 128, 256] if with_bg else [16, 20, 24, 32, 40, 48, 64]
    frames = []
    for size in sizes:
        img = rounded_bg(size) if with_bg else Image.new('RGBA', (size, size), (0, 0, 0, 0))
        # sem fundo (tray) o bicho pode ocupar mais area
        draw_sprite(img, size, body, EYE, 0.72 if with_bg else 0.94)
        frames.append(img)
    # o Pillow descarta size maior que a imagem base, entao a base tem que ser a maior
    frames.sort(key=lambda f: -f.width)
    path = out_dir / name
    frames[0].save(path, format='ICO', sizes=[(f.width, f.height) for f in frames],
                   append_images=frames[1:])
    with Image.open(path) as chk:
        got = sorted(w for w, _ in chk.info['sizes'])
    assert got == sorted(f.width for f in frames), f'{name}: gravou apenas {got}'
    print(f'{path.name}: {got}')


build(BUILD, 'icon.ico', PIXEL, True)          # icone do app (atalho, Start, instalador)
build(ASSETS, 'tray.ico', PIXEL, False)        # bandeja, estado normal
build(ASSETS, 'tray-fire.ico', FIRE, False)    # bandeja, acima do fireThreshold
