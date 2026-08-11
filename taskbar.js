// Mede onde a taskbar e a bandeja realmente estao, em pixels fisicos.
//
// Por que PowerShell e nao FFI: sao duas chamadas de user32. Trazer koffi ou
// ffi-napi por causa delas adicionaria a PRIMEIRA dependencia de runtime do
// projeto (hoje sao zero) — incluindo binario nativo por arquitetura. O script
// roda na inicializacao, a cada mudanca de display e a cada 60s enquanto a
// barra esta aberta; nao e caminho quente.
//
// Sem isso a barra so podia CHUTAR a largura da bandeja e acabava por cima
// dos icones — a bandeja muda de largura sozinha quando um icone novo aparece.
const { execFileSync } = require('node:child_process')

const SCRIPT = `
$ErrorActionPreference = 'Stop'
Add-Type -MemberDefinition @'
[DllImport("user32.dll", SetLastError=true)]
public static extern IntPtr FindWindow(string lpClassName, string lpWindowName);
[DllImport("user32.dll", SetLastError=true)]
public static extern IntPtr FindWindowEx(IntPtr hwndParent, IntPtr hwndChildAfter, string lpszClass, string lpszWindow);
[DllImport("user32.dll")]
public static extern bool GetWindowRect(IntPtr hWnd, out RECT lpRect);
[DllImport("user32.dll")]
public static extern bool SetProcessDPIAware();
public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }
'@ -Name Api -Namespace TB

# Sem isto o Windows VIRTUALIZA as coordenadas para o powershell (que e
# DPI-unaware) e os retangulos ja voltam divididos pelo scaleFactor — dividir
# de novo do lado do Electron encolheria tudo. Forcando a consciencia de DPI,
# o que volta e sempre pixel fisico e a conversao fica em um lugar so.
[void][TB.Api]::SetProcessDPIAware()

function Get-Rect([IntPtr]$h) {
  if ($h -eq [IntPtr]::Zero) { return $null }
  $r = New-Object TB.Api+RECT
  if (-not [TB.Api]::GetWindowRect($h, [ref]$r)) { return $null }
  return @{ left = $r.Left; top = $r.Top; right = $r.Right; bottom = $r.Bottom }
}

$bar = [TB.Api]::FindWindow('Shell_TrayWnd', $null)
$notify = [IntPtr]::Zero
if ($bar -ne [IntPtr]::Zero) { $notify = [TB.Api]::FindWindowEx($bar, [IntPtr]::Zero, 'TrayNotifyWnd', $null) }
@{ taskbar = (Get-Rect $bar); tray = (Get-Rect $notify) } | ConvertTo-Json -Compress
`

function valid(r) {
  return (
    r &&
    Number.isFinite(r.left) &&
    Number.isFinite(r.top) &&
    Number.isFinite(r.right) &&
    Number.isFinite(r.bottom) &&
    r.right > r.left &&
    r.bottom > r.top
  )
}

// Retorna { taskbar, tray } em pixels FISICOS, ou null se nao deu para medir
// (taskbar vertical, shell substituido, PowerShell bloqueado por politica...).
// Quem chama cai no modo estimado nesse caso.
function readTaskbar() {
  if (process.platform !== 'win32') return null
  let out
  try {
    out = execFileSync(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', SCRIPT],
      { encoding: 'utf8', timeout: 5000, windowsHide: true }
    )
  } catch {
    return null
  }
  let parsed
  try {
    parsed = JSON.parse(out)
  } catch {
    return null
  }
  if (!valid(parsed?.taskbar)) return null
  return { taskbar: parsed.taskbar, tray: valid(parsed.tray) ? parsed.tray : null }
}

module.exports = { readTaskbar }
