const {
  app,
  BrowserWindow,
  ipcMain,
  screen,
  Notification,
  shell,
  Tray,
  Menu,
} = require('electron')
const path = require('node:path')
const fs = require('node:fs')
const os = require('node:os')
const { getUsage } = require('./usage')
const auth = require('./auth')
const { readTaskbar } = require('./taskbar')
const { checkAlerts } = require('./alerts')

const DATA_DIR = process.env.CLAUDE_CONFIG_DIR
  ? path.join(process.env.CLAUDE_CONFIG_DIR, 'claude-glass')
  : path.join(os.homedir(), '.claude-glass')

if (process.env.CLAUDE_CONFIG_DIR) {
  fs.mkdirSync(DATA_DIR, { recursive: true })
  app.setPath('userData', path.join(DATA_DIR, 'electron'))
}

const EXTERNAL_CONFIG = path.join(DATA_DIR, 'config.json')

// diagnostico opcional: CLAUDE_GLASS_DEBUG=1 grava os eventos de bandeja em arquivo
const DEBUG_LOG = process.env.CLAUDE_GLASS_DEBUG ? path.join(DATA_DIR, 'tray.log') : null
function dbg(msg) {
  if (!DEBUG_LOG) return
  try {
    fs.mkdirSync(path.dirname(DEBUG_LOG), { recursive: true })
    fs.appendFileSync(DEBUG_LOG, `${new Date().toISOString()} ${msg}\n`)
  } catch {}
}

let win
let strip
let pollTimer
let stripTimer
let stripDragging = false
let config
let tray
let trayIsFire = null // null = ainda nao pintado
let quitting = false

// Ultimos dados entregues aos renderers. A barra nasce DEPOIS do painel e
// perderia as mensagens ja enviadas — ficaria sem % ate o proximo poll da API,
// cinco minutos depois. Guardar aqui deixa ela entrar em cena ja preenchida.
let lastUsage = null

function loadConfig() {
  const defaults = {
    plan: 'max5x',
    startWithWindows: true,
    trayHintShown: false,
    minimizeTo: 'inline',
    strip: {
      width: 300,
      height: 70,
      anchor: 'auto',
      gap: 8,
      reservedRight: 290,
      offsetX: 0,
      offsetY: 0,
    },
    sessionTokenBudget: 630000000,
    weeklyTokenBudget: 3450000000,
    weeklyAnchorIso: null,
    alerts: true,
    alertThresholds: [80, 95],
    fireThreshold: 90,
    pollIntervalMs: 4000,
    activeThresholdMs: 20000,
    sleepThresholdMs: 300000,
  }
  for (const p of [EXTERNAL_CONFIG, path.join(__dirname, 'config.json')]) {
    try {
      const saved = JSON.parse(fs.readFileSync(p, 'utf8'))
      // `strip` e o unico campo aninhado: com spread raso, um arquivo que
      // gravou so { strip: { x, y } } apagaria width/height/anchor/gap.
      return { ...defaults, ...saved, strip: { ...defaults.strip, ...(saved.strip || {}) } }
    } catch {}
  }
  return defaults
}

const armed = new Set()
// A regra de quem alerta vive em alerts.js; aqui so vira notificacao.
function notifyAlerts(config, local, real) {
  if (!Notification.isSupported()) return
  for (const body of checkAlerts(config, local, real, armed)) {
    new Notification({ title: 'Claude Glass', body, silent: false }).show()
  }
}

function createWindow() {
  config = loadConfig()
  const { workAreaSize } = screen.getPrimaryDisplay()
  const W = 290
  const H = 580

  win = new BrowserWindow({
    width: W,
    height: H,
    x: workAreaSize.width - W - 20,
    y: workAreaSize.height - H - 20,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    resizable: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    hasShadow: false,
    fullscreenable: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  })

  win.setAlwaysOnTop(true, 'floating')
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'))

  const tick = () => {
    if (!win || win.isDestroyed()) return
    try {
      const data = getUsage(config)
      lastUsage = data
      broadcast('usage', data)
      // o dado real tem precedencia; a estimativa local so alerta sem conta
      notifyAlerts(config, data, realUsage)
      // a leitura autoritativa (OAuth) tem precedencia sobre a estimativa local
      if (realUsage) updateTray(realUsage.session?.pct, realUsage.week?.pct, true, realUsage.scoped)
      else updateTray(data.session.pct, data.week.pct, false)
    } catch (err) {
      win.webContents.send('usage-error', String(err))
    }
  }

  win.webContents.once('did-finish-load', () => {
    win.webContents.send('config', config)
    tick()
    win.webContents.send('auth-state', { connected: auth.isConnected() })
    pollTimer = setInterval(tick, config.pollIntervalMs)
    startUsagePoll()
    sendProfile()
  })
}

// Manda o mesmo evento para o painel e para a barra — os dois renderizam os
// mesmos numeros e nao podem divergir.
function broadcast(channel, payload) {
  for (const w of [win, strip]) {
    if (w && !w.isDestroyed()) w.webContents.send(channel, payload)
  }
}

ipcMain.on('resize', (_e, w, h) => {
  if (!win || win.isDestroyed()) return
  const width = Math.max(280, Math.round(w))
  const height = Math.max(200, Math.round(h))
  win.setContentSize(width, height)
  const { workAreaSize } = screen.getPrimaryDisplay()
  win.setPosition(workAreaSize.width - width - 20, workAreaSize.height - height - 20)
})

ipcMain.on('open-usage', () => shell.openExternal('https://claude.ai/settings/usage'))

// OAuth usage polling
let usageTimer = null
let usageBackoff = 5 * 60 * 1000
let realUsage = null // ultima leitura autoritativa, usada tambem no tooltip da bandeja
function scheduleUsagePoll() {
  clearTimeout(usageTimer)
  if (auth.isConnected()) usageTimer = setTimeout(pollUsage, usageBackoff)
}
async function pollUsage() {
  try {
    const u = await auth.fetchUsage()
    usageBackoff = 5 * 60 * 1000
    realUsage = u
    updateTray(u.session?.pct, u.week?.pct, true, u.scoped)
    broadcast('real-usage', u)
  } catch (e) {
    if (e && e.status === 429) {
      usageBackoff = Math.min(usageBackoff * 2, 30 * 60 * 1000)
    } else if (e && e.status === 401) {
      auth.clear()
      realUsage = null
      broadcast('auth-state', { connected: false })
      broadcast('real-usage', null)
      if (win && !win.isDestroyed()) win.webContents.send('profile', null)
    }
  }
  scheduleUsagePoll()
}
function startUsagePoll() {
  if (auth.isConnected()) pollUsage()
}

async function sendProfile() {
  if (!auth.isConnected()) return
  try {
    const p = await auth.fetchProfile()
    if (win && !win.isDestroyed()) win.webContents.send('profile', p)
  } catch {}
}

ipcMain.on('auth-start', () => shell.openExternal(auth.begin()))
ipcMain.on('auth-code', async (_e, code) => {
  const ok = () => {
    broadcast('auth-state', { connected: true })
    if (win && !win.isDestroyed()) win.webContents.send('auth-result', { ok: true })
    sendProfile()
  }
  try {
    await auth.complete(code)
    usageBackoff = 5 * 60 * 1000
    try {
      const u = await auth.fetchUsage()
      ok()
      realUsage = u // sem isto o % real so aparecia no poll seguinte, 5min depois
      updateTray(u.session?.pct, u.week?.pct, true, u.scoped)
      broadcast('real-usage', u)
    } catch (e) {
      if (e && e.status === 429) ok()
      else throw e
    }
    scheduleUsagePoll()
  } catch (err) {
    auth.clear()
    if (win && !win.isDestroyed())
      win.webContents.send('auth-result', { ok: false, error: String(err?.message || err) })
  }
})
ipcMain.on('auth-logout', () => {
  auth.clear()
  realUsage = null
  clearTimeout(usageTimer)
  broadcast('auth-state', { connected: false })
  broadcast('real-usage', null)
  if (win && !win.isDestroyed()) win.webContents.send('profile', null)
})

function persistConfig(patch) {
  let obj = {}
  for (const p of [EXTERNAL_CONFIG, path.join(__dirname, 'config.json')]) {
    try {
      obj = JSON.parse(fs.readFileSync(p, 'utf8'))
      break
    } catch {}
  }
  // Object.assign e raso: um patch { strip: { x, y } } apagaria anchor/gap/etc.
  // `strip` e o unico aninhado, entao o merge dele fica explicito aqui.
  const { strip: stripPatch, ...flat } = patch
  Object.assign(obj, flat)
  if (stripPatch) obj.strip = { ...(obj.strip || {}), ...stripPatch }
  try {
    fs.mkdirSync(path.dirname(EXTERNAL_CONFIG), { recursive: true })
    fs.writeFileSync(EXTERNAL_CONFIG, JSON.stringify(obj, null, 2))
  } catch {}
  config = loadConfig()
  armed.clear()
  broadcast('config', config)
  applyAutoStart()
  refreshTrayMenu()
}

ipcMain.on('save-config', (_e, patch) => {
  persistConfig(patch)
  // desmarcar "minimizar para a barra" com a barra aberta devolve o painel na
  // hora — senao a opcao some do alcance junto com o painel
  if (config.minimizeTo !== 'strip' && stripVisible()) restorePanel()
})

// Com a bandeja disponivel, o "x" do widget esconde em vez de encerrar — sair de
// vez fica no menu do icone, como nos outros apps de bandeja do Windows.
ipcMain.on('quit', () => {
  if (!tray || tray.isDestroyed()) {
    quitting = true
    app.quit()
    return
  }
  hideEverything()
  if (!config.trayHintShown && Notification.isSupported()) {
    new Notification({
      title: 'Claude Glass continua na bandeja',
      body: 'Clique no bichinho perto do relógio — ou botão direito → "Mostrar widget" — para trazer de volta. Para encerrar, use "Sair" no mesmo menu.',
      silent: true,
    }).show()
    persistConfig({ trayHintShown: true })
  }
})

// Respeita a escolha da pessoa em vez de re-registrar a cada abertura.
// Padrao ligado (config.startWithWindows), mas desmarcar realmente desliga.
function applyAutoStart() {
  if (!app.isPackaged) return // em dev nao mexe na inicializacao do Windows
  app.setLoginItemSettings({
    openAtLogin: config.startWithWindows !== false,
    openAsHidden: false,
  })
}

// --- barra na taskbar -------------------------------------------------------
// Nao e uma deskband: a Microsoft removeu o suporte a toolbars na taskbar do
// Windows 11 (ela foi reescrita em XAML), e mesmo no 10 uma deskband e uma DLL
// COM carregada dentro do explorer.exe — Electron nao entra la. O que da para
// fazer e uma janela sobreposta que se alinha com a barra real.

const stripCfg = () => config.strip || {}

// Onde a barra deve ficar, em DIP. Mede a taskbar de verdade; se a leitura
// falhar (taskbar vertical, shell trocado), cai no chute antigo.
function stripTargetPosition() {
  const cfg = stripCfg()
  const width = cfg.width || 300
  const height = cfg.height || 70
  const offX = cfg.offsetX || 0
  const offY = cfg.offsetY || 0

  if (cfg.anchor === 'free' && Number.isFinite(cfg.x) && Number.isFinite(cfg.y)) {
    return clampToScreen(Math.round(cfg.x), Math.round(cfg.y), width, height)
  }

  const display = screen.getPrimaryDisplay()
  const sf = display.scaleFactor || 1
  const measured = cfg.anchor === 'manual' ? null : readTaskbar()

  if (measured) {
    // fisico -> DIP
    const bar = measured.taskbar
    const barTop = bar.top / sf
    const barBottom = bar.bottom / sf
    const rightEdge = measured.tray ? measured.tray.left / sf : bar.right / sf
    const x = Math.round(rightEdge - (cfg.gap ?? 8) - width + offX)
    // centraliza na altura da taskbar
    const y = Math.round(barTop + (barBottom - barTop - height) / 2 + offY)
    return clampToScreen(x, y, width, height)
  }

  // modo estimado: sem medicao, so resta reservar uma faixa a direita
  const { bounds } = display
  const x = Math.round(bounds.x + bounds.width - (cfg.reservedRight ?? 290) - width + offX)
  const y = Math.round(bounds.y + bounds.height - height - 4 + offY)
  return clampToScreen(x, y, width, height)
}

// Nunca deixa a barra sair inteira da tela: sempre sobram 24px agarraveis
// em algum monitor.
function clampToScreen(x, y, width, height) {
  const VISIBLE = 24
  const displays = screen.getAllDisplays()
  const fits = displays.some((d) => {
    const b = d.bounds
    return (
      x + width > b.x + VISIBLE &&
      x < b.x + b.width - VISIBLE &&
      y + height > b.y + VISIBLE &&
      y < b.y + b.height - VISIBLE
    )
  })
  if (fits) return { x: toInt(x), y: toInt(y) }
  const b = screen.getPrimaryDisplay().bounds
  return {
    x: toInt(Math.min(Math.max(x, b.x), b.x + b.width - width)),
    y: toInt(Math.min(Math.max(y, b.y), b.y + b.height - height)),
  }
}

// Coordenada de janela segura para o Electron. Math.round(-0.4) devolve -0, e
// setPosition() recusa -0 com "conversion failure" — uma excecao no processo
// principal, que vira a caixa "A JavaScript error occurred in the main
// process". Acontece de verdade: com escala de tela fracionada (125%, 150%) o
// screenY do ponteiro vem quebrado, e basta arrastar a barra cruzando o topo
// do monitor (y entre -1 e 0). `|| 0` troca -0 (e NaN) por 0.
function toInt(v) {
  return Math.round(v) || 0
}

function positionStrip() {
  if (!strip || strip.isDestroyed() || stripDragging) return
  const { x, y } = stripTargetPosition()
  strip.setPosition(x, y)
}

// Jogos e o proprio Explorer as vezes roubam o topo; reafirmar e barato.
function assertStripOnTop() {
  if (!strip || strip.isDestroyed()) return
  strip.setAlwaysOnTop(true, 'screen-saver')
}

function createStrip() {
  if (strip && !strip.isDestroyed()) {
    strip.show()
    return
  }
  const cfg = stripCfg()
  const { x, y } = stripTargetPosition()
  strip = new BrowserWindow({
    width: cfg.width || 300,
    height: cfg.height || 70,
    x,
    y,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    resizable: false,
    movable: true,
    minimizable: false,
    maximizable: false,
    skipTaskbar: true,
    hasShadow: false,
    fullscreenable: false,
    // nao pode roubar o foco de quem esta digitando
    focusable: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      // a barra nunca tem foco: sem isto o Chromium estrangula as animacoes
      backgroundThrottling: false,
    },
  })

  // 'screen-saver' e o unico nivel que fica acima da taskbar, que ja e topmost
  strip.setAlwaysOnTop(true, 'screen-saver')
  strip.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
  strip.loadFile(path.join(__dirname, 'renderer', 'strip.html'))

  strip.webContents.once('did-finish-load', () => {
    // entra em cena ja com os dados que o painel tinha
    strip.webContents.send('config', config)
    strip.webContents.send('auth-state', { connected: auth.isConnected() })
    if (lastUsage) strip.webContents.send('usage', lastUsage)
    if (realUsage) strip.webContents.send('real-usage', realUsage)
  })

  clearInterval(stripTimer)
  stripTimer = setInterval(() => {
    positionStrip() // a bandeja muda de largura quando um icone novo aparece
    assertStripOnTop()
  }, 60000)
}

function destroyStrip() {
  clearInterval(stripTimer)
  stripTimer = null
  stripDragging = false
  if (strip && !strip.isDestroyed()) strip.destroy()
  strip = null
}

const stripVisible = () => !!strip && !strip.isDestroyed()
const panelVisible = () => !!win && !win.isDestroyed() && win.isVisible()

// painel some, barra aparece
function minimizeToStrip() {
  if (!win || win.isDestroyed()) return
  win.hide()
  createStrip()
  refreshTrayMenu()
}

// barra some, painel volta
function restorePanel() {
  destroyStrip()
  if (win && !win.isDestroyed()) {
    win.show()
    win.setAlwaysOnTop(true, 'floating')
    win.moveTop()
  }
  refreshTrayMenu()
}

ipcMain.on('minimize-to-strip', minimizeToStrip)
ipcMain.on('restore-panel', restorePanel)

ipcMain.on('strip-move', (_e, dx, dy) => {
  if (!strip || strip.isDestroyed()) return
  if (!Number.isFinite(dx) || !Number.isFinite(dy)) return // delta invalido: ignora o quadro
  stripDragging = true // trava o tick de 60s, senao ele puxa a barra de volta no meio do gesto
  const [x, y] = strip.getPosition()
  strip.setPosition(toInt(x + dx), toInt(y + dy))
})

ipcMain.on('strip-move-end', () => {
  stripDragging = false
  if (!strip || strip.isDestroyed()) return
  const [x, y] = strip.getPosition()
  persistConfig({ strip: { anchor: 'free', x, y } })
})

// Trocar de monitor ou de resolucao muda onde a taskbar esta. Precisa ficar
// dentro do whenReady: o modulo `screen` nao existe antes do 'ready'.
function watchDisplays() {
  screen.on('display-metrics-changed', positionStrip)
  screen.on('display-added', positionStrip)
  screen.on('display-removed', positionStrip)
}

// --- bandeja do Windows -----------------------------------------------------
// O widget e frameless e usa skipTaskbar, entao sem isto o app nao aparece em
// lugar nenhum quando esta oculto — e nao ha como traze-lo de volta.
const trayIcon = (name) => path.join(__dirname, 'assets', name)

// Some com tudo: painel e barra. A bandeja e o unico ponto de resgate.
function hideEverything() {
  destroyStrip()
  if (win && !win.isDestroyed()) win.hide()
  refreshTrayMenu()
}

function toggleWindow() {
  if (!win || win.isDestroyed()) {
    dbg(`toggle: sem janela (win=${!!win})`)
    return
  }
  // a barra conta como "widget na tela": escondida ela tambem some
  const wasVisible = panelVisible() || stripVisible()
  if (wasVisible) hideEverything()
  else restorePanel()
  dbg(`toggle: antes=${wasVisible} depois=${win.isVisible()}`)
}

function refreshTrayMenu() {
  if (!tray || tray.isDestroyed()) return
  const visible = panelVisible() || stripVisible()
  tray.setContextMenu(
    Menu.buildFromTemplate([
      {
        label: visible ? 'Ocultar widget' : 'Mostrar widget',
        click: () => {
          dbg('evento: item do menu')
          toggleWindow()
        },
      },
      { type: 'separator' },
      {
        label: 'Ver uso no claude.ai',
        click: () => shell.openExternal('https://claude.ai/settings/usage'),
      },
      {
        label: 'Iniciar com o Windows',
        type: 'checkbox',
        checked: config.startWithWindows !== false,
        click: (item) => persistConfig({ startWithWindows: item.checked }),
      },
      { type: 'separator' },
      {
        label: 'Sair',
        click: () => {
          quitting = true
          app.quit()
        },
      },
    ])
  )
}

const fmtPct = (v) => (Number.isFinite(v) ? `${Math.round(v)}%` : '—')

function updateTray(session, week, real, scoped) {
  if (!tray || tray.isDestroyed()) return
  const fire = Number.isFinite(session) && session >= (config.fireThreshold ?? 90)
  if (fire !== trayIsFire) {
    tray.setImage(trayIcon(fire ? 'tray-fire.ico' : 'tray.ico'))
    trayIsFire = fire
  }
  const src = real ? '' : ' (estimativa)'
  // os limites por modelo entram como linhas extras; sem eles o tooltip fica igual
  const lines = (scoped || []).map((m) => `7 dias · ${m.label}: ${fmtPct(m.pct)}`)
  tray.setToolTip(
    [`Claude Glass${src}`, `Sessão: ${fmtPct(session)}`, `7 dias: ${fmtPct(week)}`, ...lines].join(
      '\n',
    ),
  )
}

function createTray() {
  tray = new Tray(trayIcon('tray.ico'))
  trayIsFire = false
  tray.setToolTip('Claude Glass')
  tray.on('click', () => {
    dbg('evento: click')
    toggleWindow()
  })
  tray.on('double-click', () => {
    dbg('evento: double-click')
    toggleWindow()
  })
  refreshTrayMenu()
  dbg('bandeja criada')
}

// Duas instancias significariam dois widgets sobrepostos e dois icones na bandeja.
if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (win && !win.isDestroyed()) restorePanel()
  })

  app.whenReady().then(() => {
    if (process.platform === 'win32') app.setAppUserModelId('com.datasystem.claude-glass')
    createWindow() // define `config`
    createTray()
    watchDisplays()
    applyAutoStart()
  })
}

// Com a bandeja ativa, fechar/ocultar a janela nao pode derrubar o app.
app.on('window-all-closed', () => {
  if (!quitting) return
  if (pollTimer) clearInterval(pollTimer)
  app.quit()
})

app.on('before-quit', () => {
  quitting = true
  if (pollTimer) clearInterval(pollTimer)
  clearInterval(stripTimer)
  if (tray && !tray.isDestroyed()) tray.destroy()
})
