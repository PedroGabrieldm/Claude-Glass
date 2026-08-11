// Barra compacta sobre a taskbar: mesmo conteudo do painel em formato de pilula.
// Ela e o widget MINIMIZADO — nao um segundo app. Por isso nao tem botao de
// fechar: um clique curto devolve o painel.

const el = (id) => document.getElementById(id)

buildPetSprite(el('body'), el('eyes'))
buildHatSprite(el('hardhat'))

let currentConfig = {}
let realUsage = null
let lastUsage = null

function setState(name) {
  const b = document.body
  ;[...b.classList].forEach((c) => {
    if (c.startsWith('state-')) b.classList.remove(c)
  })
  b.classList.add(`state-${name}`)
}

const LABEL = {
  working: 'trabalhando',
  sleeping: 'dormindo',
  stressed: 'pegando fogo',
  tired: 'no limite',
  idle: 'ocioso',
}

function render() {
  const d = lastUsage
  // Mesma regra do painel: "%" so existe com conta conectada. Sem ela mostramos
  // "—", nunca a estimativa local — senao a barra diz 8% e o painel diz 45%.
  const liveOn = !!realUsage
  const sessPct = liveOn ? realUsage.session.pct : 0
  const wkPct = liveOn ? realUsage.week.pct : 0
  const fireAt = currentConfig.fireThreshold ?? 90

  const st =
    liveOn && sessPct >= 100
      ? 'tired'
      : d && d.active
        ? 'working'
        : liveOn && sessPct >= fireAt
          ? 'stressed'
          : d && d.sleeping
            ? 'sleeping'
            : 'idle'
  setState(st)

  el('session-pct').textContent = liveOn ? `${Math.round(sessPct)}%` : '—'
  el('week-pct').textContent = liveOn ? `${Math.round(wkPct)}%` : '—'
  el('session-fill').style.width = `${Math.min(100, sessPct)}%`
  el('week-fill').style.width = `${Math.min(100, wkPct)}%`

  // sem rotulo de texto na pilula: a bolinha carrega o status e a palavra
  // vive no tooltip (decisao do wireframe)
  el('pill').title = liveOn
    ? `Claude Glass · ${LABEL[st]}\nSessão ${Math.round(sessPct)}% · 7 dias ${Math.round(wkPct)}%`
    : `Claude Glass · ${LABEL[st]}\nConecte a conta para ver o uso em %`
}

window.api.onConfig((cfg) => {
  currentConfig = cfg || {}
  render()
})
window.api.onUsage((d) => {
  lastUsage = d
  render()
})
window.api.onRealUsage((u) => {
  realUsage = u || null
  render()
})
window.api.onAuthState((s) => {
  if (!s || !s.connected) realUsage = null
  render()
})

// ---- arrastar / restaurar ----
// Feito na mao em vez de -webkit-app-region: drag — a janela e focusable:false
// e o app-region nao funciona de forma confiavel nesse modo.
const DRAG_SLOP = 4 // abaixo disso o gesto conta como clique
const pill = el('pill')
let dragging = false
let lastX = 0
let lastY = 0
let travelled = 0

pill.addEventListener('pointerdown', (e) => {
  if (e.button !== 0) return
  dragging = true
  travelled = 0
  lastX = e.screenX
  lastY = e.screenY
  // ponteiro sintetico (teste) nao tem captura para conceder — o gesto
  // funciona igual sem ela, entao nao vale derrubar o handler por isso
  try {
    pill.setPointerCapture(e.pointerId)
  } catch {}
})

pill.addEventListener('pointermove', (e) => {
  if (!dragging) return
  const dx = e.screenX - lastX
  const dy = e.screenY - lastY
  if (!dx && !dy) return
  lastX = e.screenX
  lastY = e.screenY
  travelled += Math.abs(dx) + Math.abs(dy)
  window.api.stripMove(dx, dy)
})

function endDrag(e) {
  if (!dragging) return
  dragging = false
  try {
    pill.releasePointerCapture(e.pointerId)
  } catch {}
  if (travelled < DRAG_SLOP) window.api.restorePanel()
  // grava a posicao so no fim do gesto: salvar a cada pixel marteleria o disco
  else window.api.stripMoveEnd()
}

pill.addEventListener('pointerup', endDrag)
pill.addEventListener('pointercancel', endDrag)

render()
