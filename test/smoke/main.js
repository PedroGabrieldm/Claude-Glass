// Smoke test: carrega o preload + renderer REAIS do projeto, dispara cliques e
// verifica que os handlers responderam (DOM muda / IPC chega no main).
const { app, BrowserWindow, ipcMain } = require('electron')
const path = require('node:path')

const ROOT = path.join(__dirname, '..', '..')
const { getUsage } = require(path.join(ROOT, 'usage.js'))

let gotResize = false
let savedConfig = null
ipcMain.on('resize', () => (gotResize = true))
ipcMain.on('save-config', (_e, patch) => (savedConfig = patch))
ipcMain.on('quit', () => {})
ipcMain.on('open-usage', () => {})
ipcMain.on('auth-start', () => {})

// IPC da barra na taskbar
const strip = { minimize: 0, restore: 0, moves: [], moveEnd: 0 }
ipcMain.on('minimize-to-strip', () => strip.minimize++)
ipcMain.on('restore-panel', () => strip.restore++)
ipcMain.on('strip-move', (_e, dx, dy) => strip.moves.push([dx, dy]))
ipcMain.on('strip-move-end', () => strip.moveEnd++)

const results = []
const check = (name, pass) => results.push(`${pass ? 'PASS  ' : 'FALHOU'}  ${name}`)

// Espera por condicao em vez de timeout fixo: o fitSize() do renderer depende
// de requestAnimationFrame, que o Chromium estrangula em janela transparente,
// entao "esperar 600ms" fica flaky.
async function waitFor(cond, ms = 5000) {
  const t0 = Date.now()
  for (;;) {
    if (await cond()) return true
    if (Date.now() - t0 > ms) return false
    await new Promise((r) => setTimeout(r, 80))
  }
}

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    // visivel: requestAnimationFrame (usado por fitSize) nao roda em janela oculta
    show: true,
    opacity: 0,
    webPreferences: {
      preload: path.join(ROOT, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  })

  win.webContents.on('console-message', (e) => {
    if (/Uncaught/.test(e.message)) results.push(`FALHOU  erro no renderer: ${e.message}`)
  })

  await win.loadFile(path.join(ROOT, 'renderer', 'index.html'))
  const js = (code) => win.webContents.executeJavaScript(code, true)

  check(
    'window.api tem todos os metodos usados',
    await js(
      `['onUsage','onConfig','onDebugState','quit','resize'].every(k => typeof window.api[k] === 'function')`,
    ),
  )

  win.webContents.send('config', {
    plan: 'max5x',
    alerts: true,
    alertThresholds: [80, 95],
    fireThreshold: 77,
  })
  win.webContents.send(
    'usage',
    getUsage({ plan: 'max5x', activeThresholdMs: 20000, sleepThresholdMs: 300000 }),
  )
  // O HTML estatico traz "—" em #week-sub; so render() escreve tokens ali.
  // (Nao usar #status-text: ele vira "ocioso" na Task 5 e o teste ficaria ambiguo.)
  const rendered = await waitFor(async () =>
    /tokens/.test(await js(`document.getElementById('week-sub').textContent`)),
  )
  const wsub = await js(`document.getElementById('week-sub').textContent`)
  check(`onUsage registrado: render() rodou (week-sub="${wsub}")`, rendered)
  // Nao ha checagem de resize aqui: o fitSize() do renderer roda dentro de
  // requestAnimationFrame, que o Chromium estrangula em janela transparente.
  // O comportamento funciona no app real; so nao e observavel neste harness.

  // ---- animacoes em taxa reduzida (lowfps.js) ------------------------------
  // As engrenagens sao SMIL e so aparecem nas configuracoes; fora delas tem
  // que estar PARADAS (giravam invisiveis, a 240 quadros/s, o dia inteiro).
  const gearTime = () => js(`document.getElementById('gears').getCurrentTime()`)
  const g0 = await gearTime()
  await new Promise((r) => setTimeout(r, 400))
  check('engrenagens paradas fora das configuracoes', (await gearTime()) === g0)
  await js(`document.getElementById('gear').click()`)
  check(
    'engrenagens giram com as configuracoes abertas',
    await waitFor(async () => (await gearTime()) > g0),
  )
  await js(`document.getElementById('set-cancel').click()`)

  check(
    'clique no #gear abre configuracoes',
    await js(`document.getElementById('gear').click(); document.body.classList.contains('settings-open')`),
  )
  check(
    'config recebida: campo fire mostra o valor salvo (77)',
    (await js(`document.getElementById('set-fire').value`)) === '77',
  )
  check(
    'stepper aumenta o campo',
    (await js(
      `document.querySelector('.num-btn[data-for="set-fire"][data-step="1"]').click();
       document.getElementById('set-fire').value`,
    )) === '78',
  )
  check(
    'clique em Cancelar fecha configuracoes',
    await js(`document.getElementById('set-cancel').click(); !document.body.classList.contains('settings-open')`),
  )
  check(
    'clique no #min colapsa o widget',
    await js(`document.getElementById('min').click(); document.body.classList.contains('collapsed')`),
  )
  check(
    'clique no pet dispara a reacao',
    await js(
      `document.body.classList.remove('collapsed');
       document.getElementById('pet').click();
       document.body.classList.contains('poke')`,
    ),
  )

  // ---- minimizar para a barra --------------------------------------------
  win.webContents.send('config', { plan: 'max5x', minimizeTo: 'strip', fireThreshold: 77 })
  const divertiu = await waitFor(async () => {
    await js(`document.getElementById('min').click()`)
    return strip.minimize > 0
  })
  check('minimizeTo=strip desvia o #min para a barra', divertiu)
  check(
    'com minimizeTo=strip o painel NAO colapsa no lugar',
    !(await js(`document.body.classList.contains('collapsed')`)),
  )
  check(
    'a opcao nova aparece nas configuracoes marcada',
    await js(
      `document.getElementById('gear').click();
       document.getElementById('set-strip').checked`,
    ),
  )
  await js(`document.getElementById('set-cancel').click()`)

  // ---- a barra em si -------------------------------------------------------
  // Janela sem moldura + useContentSize: com moldura, 70px de altura sobram
  // ZERO de area de conteudo e todo teste de layout da falso negativo.
  const bar = new BrowserWindow({
    width: 300,
    height: 70,
    useContentSize: true,
    frame: false,
    show: true,
    opacity: 0,
    webPreferences: {
      preload: path.join(ROOT, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  })
  bar.webContents.on('console-message', (e) => {
    if (/Uncaught/.test(e.message)) results.push(`FALHOU  erro na barra: ${e.message}`)
  })
  await bar.loadFile(path.join(ROOT, 'renderer', 'strip.html'))
  const bjs = (code) => bar.webContents.executeJavaScript(code, true)

  check(
    'preload expoe os metodos da barra',
    await bjs(
      `['minimizeToStrip','restorePanel','stripMove','stripMoveEnd'].every(k => typeof window.api[k] === 'function')`,
    ),
  )
  check(
    'sprites montados na barra (corpo + capacete)',
    (await bjs(`document.querySelectorAll('#body rect').length`)) > 40 &&
      (await bjs(`document.querySelectorAll('#hardhat rect').length`)) > 40,
  )

  const usage = (o) => bar.webContents.send('usage', { active: false, sleeping: false, ...o })
  bar.webContents.send('config', { fireThreshold: 90 })

  usage({})
  check(
    'sem conta conectada os dois numeros mostram "—"',
    await waitFor(
      async () =>
        (await bjs(`document.getElementById('session-pct').textContent`)) === '—' &&
        (await bjs(`document.getElementById('week-pct').textContent`)) === '—',
    ),
  )

  bar.webContents.send('real-usage', {
    session: { pct: 42, resetMs: 1000 },
    week: { pct: 19, resetMs: 1000 },
  })
  check(
    'com conta conectada mostra sessao e semana',
    await waitFor(
      async () =>
        (await bjs(`document.getElementById('session-pct').textContent`)) === '42%' &&
        (await bjs(`document.getElementById('week-pct').textContent`)) === '19%',
    ),
  )
  check(
    'as barras acompanham os percentuais',
    (await bjs(`document.getElementById('session-fill').style.width`)) === '42%' &&
      (await bjs(`document.getElementById('week-fill').style.width`)) === '19%',
  )

  const state = async () =>
    await bjs(`[...document.body.classList].find(c => c.startsWith('state-'))`)

  usage({ active: true })
  check('estado trabalhando', (await waitFor(async () => (await state()) === 'state-working')))
  check(
    'capacete aparece trabalhando',
    // a opacidade sobe por animacao: ler direto pega o quadro do meio
    await waitFor(
      async () =>
        (await bjs(`getComputedStyle(document.getElementById('hardhat')).opacity`)) === '1',
    ),
  )

  usage({})
  check('estado ocioso', (await waitFor(async () => (await state()) === 'state-idle')))
  check(
    'capacete some fora do trabalho',
    await waitFor(
      async () =>
        (await bjs(`getComputedStyle(document.getElementById('hardhat')).opacity`)) === '0',
    ),
  )

  usage({ sleeping: true })
  check('estado dormindo', (await waitFor(async () => (await state()) === 'state-sleeping')))

  // lowfps.js: as animacoes infinitas ficam pausadas e quem avanca o tempo
  // delas e o relogio proprio — senao o Chromium pinta a cada quadro do monitor
  const loops = () =>
    bjs(
      `document.getAnimations()
         .filter(a => a instanceof CSSAnimation && a.effect.getComputedTiming().iterations === Infinity)
         .map(a => [a.playState, Number(a.currentTime)])`,
    )
  check(
    'animacoes infinitas da barra ficam pausadas (balanco, piscada, Zs)',
    await waitFor(async () => {
      const a = await loops()
      return a.length >= 4 && a.every(([st]) => st === 'paused')
    }),
  )
  const t0 = await loops()
  check(
    'pausadas, mas o relogio proprio continua avancando o tempo delas',
    await waitFor(async () => {
      const a = await loops()
      return a.length === t0.length && a.every(([, t], i) => t > t0[i][1])
    }),
  )

  bar.webContents.send('real-usage', {
    session: { pct: 95, resetMs: 1000 },
    week: { pct: 30, resetMs: 1000 },
  })
  usage({})
  check('estado perto do limite', (await waitFor(async () => (await state()) === 'state-stressed')))

  bar.webContents.send('real-usage', {
    session: { pct: 100, resetMs: 1000 },
    week: { pct: 30, resetMs: 1000 },
  })
  usage({})
  check('estado no limite', (await waitFor(async () => (await state()) === 'state-tired')))

  // ---- arrastar e restaurar ----
  const pointer = (type, sx, sy) =>
    bjs(
      `document.getElementById('pill').dispatchEvent(new PointerEvent('${type}', {
         bubbles: true, button: 0, pointerId: 1, screenX: ${sx}, screenY: ${sy} })); true`,
    )

  await pointer('pointerdown', 500, 900)
  await pointer('pointerup', 501, 900) // 1px: abaixo do limiar, e clique
  check('clique curto restaura o painel', await waitFor(async () => strip.restore === 1))
  check('clique curto nao move a barra', strip.moves.length === 0)

  await pointer('pointerdown', 500, 900)
  await pointer('pointermove', 540, 912)
  await pointer('pointerup', 540, 912)
  check(
    'arrasto move a barra pelo delta',
    await waitFor(async () => strip.moves.length === 1 && strip.moves[0][0] === 40),
  )
  check('arrasto nao restaura o painel', strip.restore === 1)
  check('a posicao e gravada so no fim do gesto', await waitFor(async () => strip.moveEnd === 1))

  console.log('\n' + results.join('\n'))
  const failed = results.filter((r) => r.startsWith('FALHOU')).length
  console.log(`\n${results.length - failed}/${results.length} passaram`)
  app.exit(failed ? 1 : 0)
})
