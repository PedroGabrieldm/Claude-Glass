// O refresh_token da Anthropic e rotativo e de uso unico: renovar invalida o
// anterior. No arranque, main.js dispara startUsagePoll() e sendProfile() no
// mesmo tick — as duas renovam ao mesmo tempo com o MESMO refresh_token, e a
// segunda leva 400 invalid_grant. Quando quem perde e o poll de uso, ele trata
// como 401 e apaga auth.json: o usuario tem que logar de novo no dia seguinte.
//
// Este teste simula o servidor com rotacao de uso unico e exige que duas
// chamadas simultaneas com o token vencido produzam UMA unica renovacao.
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-glass-test-'))
process.env.CLAUDE_CONFIG_DIR = TMP
const TOKEN_PATH = path.join(TMP, 'usage-monitor', 'auth.json')

fs.mkdirSync(path.dirname(TOKEN_PATH), { recursive: true })
fs.writeFileSync(
  TOKEN_PATH,
  JSON.stringify({ access_token: 'AT-0', refresh_token: 'RT-1', expires_at: Date.now() - 1000 })
)

// --- servidor simulado -------------------------------------------------
let serverRefresh = 'RT-1'
let serverAccess = 'AT-1'
let rotacoes = 0
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
    // uso unico: so o refresh_token corrente e aceito
    if (body.refresh_token !== serverRefresh) {
      return json(400, { error: 'invalid_grant', error_description: 'Refresh token not found or invalid' })
    }
    rotacoes++
    serverRefresh = `RT-${rotacoes + 1}`
    serverAccess = `AT-${rotacoes + 1}`
    return json(200, { access_token: serverAccess, refresh_token: serverRefresh, expires_in: 28800 })
  }

  const bearer = String(opts.headers?.Authorization || '').replace('Bearer ', '')
  if (bearer !== serverAccess) return json(401, { error: 'unauthorized' })

  if (String(url).includes('/oauth/usage')) {
    return json(200, { five_hour: { utilization: 3 }, seven_day: { utilization: 9 } })
  }
  return json(200, { account: { email: 'x@y.z', display_name: 'X', has_claude_max: true } })
}
// -----------------------------------------------------------------------

const auth = require('../auth.js')

let falhas = 0
const check = (ok, msg) => {
  console.log(`${ok ? 'ok  ' : 'FALHOU'}  ${msg}`)
  if (!ok) falhas++
}

;(async () => {
  // exatamente o que main.js faz no did-finish-load (linhas 166-167)
  const [uso, perfil] = await Promise.allSettled([auth.fetchUsage(), auth.fetchProfile()])

  check(refreshRequests === 1, `uma unica renovacao no arranque (foram ${refreshRequests})`)
  check(
    uso.status === 'fulfilled',
    `fetchUsage completou${uso.status === 'rejected' ? ` — rejeitou com ${uso.reason?.status} ${uso.reason?.message}` : ''}`
  )
  check(
    perfil.status === 'fulfilled',
    `fetchProfile completou${perfil.status === 'rejected' ? ` — rejeitou com ${perfil.reason?.status} ${perfil.reason?.message}` : ''}`
  )

  // nenhum 401 deve ter escapado: e ele que faz main.js apagar auth.json
  const status401 = [uso, perfil].filter((r) => r.status === 'rejected' && r.reason?.status === 401)
  check(status401.length === 0, 'nenhuma chamada devolveu 401 (401 apaga o login em main.js:209)')

  const salvo = JSON.parse(fs.readFileSync(TOKEN_PATH, 'utf8'))
  check(salvo.refresh_token === serverRefresh, 'auth.json guardou o refresh_token corrente do servidor')

  fs.rmSync(TMP, { recursive: true, force: true })
  if (falhas) {
    console.error(`\n${falhas} verificacao(oes) falharam.`)
    process.exit(1)
  }
  console.log('\nOK - renovacao de token e a prova de corrida.')
})()
