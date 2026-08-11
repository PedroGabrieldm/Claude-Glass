// Sprites pixel-art compartilhados pelo painel (pet.js) e pela barra (strip.js).
// Script classico (sem modulos): carregado antes dos dois.
//
// Estava duplicado nos dois renderers — mexer no corpo do pet exigia editar
// os dois arquivos e torcer para nao divergirem.

const SVGNS = 'http://www.w3.org/2000/svg'

// corpo do Claude. '#' = pixel, 'o' = olho, '.' = vazio
const PET_SPRITE = [
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

// capacete de obra. L = brilho, Y = corpo, D = aba de sombra, B = aba
const HAT_SPRITE = [
  '.....YLLY.....',
  '...YYYLLYYY...',
  '..YYYYLLYYYY..',
  '.YYYYYLLYYYYY.',
  '.DDDDDDDDDDDD.',
  'BBBBBBBBBBBBBB',
]

const HAT_COLORS = { L: '#ffe27a', Y: '#f5c518', D: '#d99a00', B: '#c98f14' }

// Desenha o corpo em `bodyEl` e os olhos em `eyesEl` (os olhos saem duplicados
// de proposito: ficam num grupo proprio para piscar sem redesenhar o corpo).
// A cor vem do CSS — aqui nao se pinta nada, so geometria.
function buildPetSprite(bodyEl, eyesEl, cell = 10) {
  if (!bodyEl) return
  const rect = (x, y) => {
    const r = document.createElementNS(SVGNS, 'rect')
    r.setAttribute('x', x)
    r.setAttribute('y', y)
    r.setAttribute('width', cell)
    r.setAttribute('height', cell)
    return r
  }
  PET_SPRITE.forEach((row, r) => {
    for (let c = 0; c < row.length; c++) {
      const ch = row[c]
      if (ch === '.') continue
      bodyEl.appendChild(rect(c * cell, r * cell))
      if (ch === 'o' && eyesEl) eyesEl.appendChild(rect(c * cell, r * cell))
    }
  })
}

// Capacete posicionado sobre a cabeca. Aqui a cor vai inline: sao quatro tons
// fixos do proprio objeto, nao um estado do tema.
function buildHatSprite(g, { cell = 8, centerX = 50, top = -24 } = {}) {
  if (!g) return
  const ox = centerX - (HAT_SPRITE[0].length * cell) / 2
  HAT_SPRITE.forEach((row, r) => {
    for (let c = 0; c < row.length; c++) {
      const ch = row[c]
      if (ch === '.') continue
      const rect = document.createElementNS(SVGNS, 'rect')
      rect.setAttribute('x', ox + c * cell)
      rect.setAttribute('y', top + r * cell)
      rect.setAttribute('width', cell)
      rect.setAttribute('height', cell)
      rect.setAttribute('fill', HAT_COLORS[ch])
      g.appendChild(rect)
    }
  })
}
