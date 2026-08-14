// Um 401 do endpoint de uso faz main.js chamar auth.clear() e apagar auth.json
// — mesmo quando o refresh_token continua bom. Ai o usuario tem que logar de
// novo por causa de um access_token recusado que daria para renovar sozinho.
//
// Aqui o access_token guardado esta dentro da validade mas o servidor o recusa
// (revogado/rotacionado por fora). A sessao so pode morrer se a RENOVACAO for
// rejeitada; um 401 da API tem que virar uma renovacao e uma nova tentativa.
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-glass-test-'))
process.env.CLAUDE_CONFIG_DIR = TMP
const TOKEN_PATH = path.join(TMP, 'usage-monitor', 'auth.json')

fs.mkdirSync(path.dirname(TOKEN_PATH), { recursive: true })
// dentro da validade, mas o servidor nao aceita mais este access_token
fs.writeFileSync(
  TOKEN_PATH,
  JSON.stringify({ access_token: 'AT-velho', refresh_token: 'RT-1', expires_at: Date.now() + 6 * 3600e3 })
)

let serverRefresh = 'RT-1'
let serverAccess = 'AT-bom'
let refreshRequests = 0

global.fetch = async (url, opts = {}) => {
  const json = (status, body) => ({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  })

  if (String(url).includes('/oauth/token')) {
    refreshRequests++
    const body = JSON.parse(opts.body)
    if (body.refresh_token !== serverRefresh) return json(400, { error: 'invalid_grant' })
    serverRefresh = 'RT-2'
    serverAccess = 'AT-novo'
    return json(200, { access_token: serverAccess, refresh_token: serverRefresh, expires_in: 28800 })
  }

  const bearer = String(opts.headers?.Authorization || '').replace('Bearer ', '')
  if (bearer !== serverAccess) return json(401, { error: 'unauthorized' })
  return json(200, { five_hour: { utilization: 3 }, seven_day: { utilization: 9 } })
}

const auth = require('../auth.js')

let falhas = 0
const check = (ok, msg) => {
  console.log(`${ok ? 'ok  ' : 'FALHOU'}  ${msg}`)
  if (!ok) falhas++
}

;(async () => {
  const r = await Promise.allSettled([auth.fetchUsage()])
  const res = r[0]

  check(
    res.status === 'fulfilled',
    `fetchUsage se recuperou do 401 renovando${res.status === 'rejected' ? ` — rejeitou com ${res.reason?.status} ${res.reason?.message}` : ''}`
  )
  check(res.status !== 'rejected' || res.reason?.status !== 401, 'nao propagou 401 (401 apaga o login)')
  check(refreshRequests === 1, `renovou uma vez para se recuperar (foram ${refreshRequests})`)
  if (res.status === 'fulfilled') check(res.value.session.pct === 3, 'devolveu o uso real depois da retentativa')

  fs.rmSync(TMP, { recursive: true, force: true })
  if (falhas) {
    console.error(`\n${falhas} verificacao(oes) falharam.`)
    process.exit(1)
  }
  console.log('\nOK - 401 da API vira renovacao, nao logout.')
})()
