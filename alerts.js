// Quais alertas devem disparar agora. Puro de proposito: o main.js so vira o
// resultado em Notification, e o teste roda sem Electron.
//
// A leitura autoritativa (conta conectada) manda em tudo. Sem ela sobra a
// estimativa local, que vai marcada como estimativa no texto — o painel nunca
// mostra % estimada, entao um alerta sem ressalva contradiria a tela.

// Cada janela que pode alertar. Com a conta conectada, os tetos semanais por
// modelo entram como janelas proprias: sem isso da para encostar em 90% do teto
// do Fable sem nenhum aviso, porque o teto geral ainda esta baixo.
function scopesOf(local, real) {
  if (real) {
    const out = [
      { key: 'sessao', name: 'A sessão', pct: real.session?.pct },
      { key: 'semana', name: 'O uso semanal', pct: real.week?.pct },
    ]
    for (const m of real.scoped || []) {
      out.push({ key: `semana:${m.label}`, name: `O uso semanal de ${m.label}`, pct: m.pct })
    }
    return out
  }
  return [
    { key: 'sessao', name: 'A sessão', pct: local?.session?.pct },
    { key: 'semana', name: 'O uso semanal', pct: local?.week?.pct },
  ]
}

// `armed` guarda os limiares ja avisados, para nao repetir a cada tick; e
// mutado aqui. Devolve os textos a notificar (vazio na maioria das chamadas).
function checkAlerts(config, local, real, armed) {
  const out = []
  if (!config.alerts) return out
  const ths = config.alertThresholds || [80, 95]
  const suffix = real ? '' : ' (estimativa)'

  const live = new Set()
  for (const sc of scopesOf(local, real)) {
    if (!Number.isFinite(sc.pct)) continue
    for (const t of ths) {
      const key = `${sc.key}:${t}`
      live.add(key)
      if (sc.pct >= t) {
        if (!armed.has(key)) {
          armed.add(key)
          out.push(`${sc.name} passou de ${t}% — agora em ${Math.round(sc.pct)}%${suffix}`)
        }
      } else {
        armed.delete(key)
      }
    }
  }
  // Uma janela que sai da lista — modelo que perde o teto proprio, conta que
  // desconecta, limiar que o usuario troca — nao pode deixar a chave armada
  // para sempre: assim ela nunca mais avisaria ao voltar.
  for (const k of armed) if (!live.has(k)) armed.delete(k)
  return out
}

module.exports = { checkAlerts }
