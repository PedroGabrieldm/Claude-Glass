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
let pollTimer
let config
let tray
let trayIsFire = null // null = ainda nao pintado
let quitting = false

function loadConfig() {
  const defaults = {
    plan: 'max5x',
    startWithWindows: true,
    trayHintShown: false,
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
      return { ...defaults, ...JSON.parse(fs.readFileSync(p, 'utf8')) }
    } catch {}
  }
  return defaults
}

const armed = new Set()
function checkAlerts(config, d) {
  if (!config.alerts || !Notification.isSupported()) return
  const ths = config.alertThresholds || [80, 95]
  const scopes = [
    ['sessão', d.session.pct],
    ['uso semanal', d.week.pct],
  ]
  for (const [name, pct] of scopes) {
    for (const t of ths) {
      const key = `${name}:${t}`
      if (pct >= t) {
        if (!armed.has(key)) {
          armed.add(key)
          new Notification({
            title: 'Claude Glass',
            body: `Sua ${name} passou de ${t}% — agora em ${Math.round(pct)}%`,
            silent: false,
          }).show()
        }
      } else {
        armed.delete(key)
      }
    }
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
      win.webContents.send('usage', data)
      checkAlerts(config, data)
      // a leitura autoritativa (OAuth) tem precedencia sobre a estimativa local
      if (realUsage) updateTray(realUsage.session?.pct, realUsage.week?.pct, true)
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
    updateTray(u.session?.pct, u.week?.pct, true)
    if (win && !win.isDestroyed()) win.webContents.send('real-usage', u)
  } catch (e) {
    if (e && e.status === 429) {
      usageBackoff = Math.min(usageBackoff * 2, 30 * 60 * 1000)
    } else if (e && e.status === 401) {
      auth.clear()
      realUsage = null
      if (win && !win.isDestroyed()) {
        win.webContents.send('auth-state', { connected: false })
        win.webContents.send('real-usage', null)
        win.webContents.send('profile', null)
      }
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
    if (win && !win.isDestroyed()) {
      win.webContents.send('auth-state', { connected: true })
      win.webContents.send('auth-result', { ok: true })
    }
    sendProfile()
  }
  try {
    await auth.complete(code)
    usageBackoff = 5 * 60 * 1000
    try {
      const u = await auth.fetchUsage()
      ok()
      if (win && !win.isDestroyed()) win.webContents.send('real-usage', u)
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
  if (win && !win.isDestroyed()) {
    win.webContents.send('auth-state', { connected: false })
    win.webContents.send('real-usage', null)
    win.webContents.send('profile', null)
  }
})

function saveConfig(patch) {
  let obj = {}
  for (const p of [EXTERNAL_CONFIG, path.join(__dirname, 'config.json')]) {
    try {
      obj = JSON.parse(fs.readFileSync(p, 'utf8'))
      break
    } catch {}
  }
  Object.assign(obj, patch)
  try {
    fs.mkdirSync(path.dirname(EXTERNAL_CONFIG), { recursive: true })
    fs.writeFileSync(EXTERNAL_CONFIG, JSON.stringify(obj, null, 2))
  } catch {}
  config = loadConfig()
  armed.clear()
  if (win && !win.isDestroyed()) win.webContents.send('config', config)
  applyAutoStart()
  refreshTrayMenu()
}

ipcMain.on('save-config', (_e, patch) => saveConfig(patch))

// Com a bandeja disponivel, o "x" do widget esconde em vez de encerrar — sair de
// vez fica no menu do icone, como nos outros apps de bandeja do Windows.
ipcMain.on('quit', () => {
  if (!tray || tray.isDestroyed()) {
    quitting = true
    app.quit()
    return
  }
  if (win && !win.isDestroyed()) win.hide()
  refreshTrayMenu()
  if (!config.trayHintShown && Notification.isSupported()) {
    new Notification({
      title: 'Claude Glass continua na bandeja',
      body: 'Clique no bichinho perto do relógio — ou botão direito → "Mostrar widget" — para trazer de volta. Para encerrar, use "Sair" no mesmo menu.',
      silent: true,
    }).show()
    saveConfig({ trayHintShown: true })
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

// --- bandeja do Windows -----------------------------------------------------
// O widget e frameless e usa skipTaskbar, entao sem isto o app nao aparece em
// lugar nenhum quando esta oculto — e nao ha como traze-lo de volta.
const trayIcon = (name) => path.join(__dirname, 'assets', name)

function toggleWindow() {
  if (!win || win.isDestroyed()) {
    dbg(`toggle: sem janela (win=${!!win})`)
    return
  }
  const wasVisible = win.isVisible()
  if (wasVisible) {
    win.hide()
  } else {
    win.show()
    win.setAlwaysOnTop(true, 'floating')
    win.moveTop()
  }
  dbg(`toggle: antes=${wasVisible} depois=${win.isVisible()}`)
  refreshTrayMenu()
}

function refreshTrayMenu() {
  if (!tray || tray.isDestroyed()) return
  const visible = !!win && !win.isDestroyed() && win.isVisible()
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
        click: (item) => saveConfig({ startWithWindows: item.checked }),
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

function updateTray(session, week, real) {
  if (!tray || tray.isDestroyed()) return
  const fire = Number.isFinite(session) && session >= (config.fireThreshold ?? 90)
  if (fire !== trayIsFire) {
    tray.setImage(trayIcon(fire ? 'tray-fire.ico' : 'tray.ico'))
    trayIsFire = fire
  }
  const src = real ? '' : ' (estimativa)'
  tray.setToolTip(`Claude Glass${src}\nSessão: ${fmtPct(session)}\n7 dias: ${fmtPct(week)}`)
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
    if (win && !win.isDestroyed()) {
      win.show()
      win.setAlwaysOnTop(true, 'floating')
      refreshTrayMenu()
    }
  })

  app.whenReady().then(() => {
    if (process.platform === 'win32') app.setAppUserModelId('com.datasystem.claude-glass')
    createWindow() // define `config`
    createTray()

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

  if (tray && !tray.isDestroyed()) tray.destroy()
})
