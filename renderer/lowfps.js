// Relogio proprio para as animacoes infinitas (balanco, piscada, Zs, vapor...).
//
// Por que existe: uma animacao CSS infinita obriga o Chromium a produzir um
// quadro a cada atualizacao do monitor. Num painel de 240 Hz sao 240 quadros
// por segundo para mexer um bichinho de 34px — medido em ~27% de um nucleo
// com o widget parado, 24h por dia. E como a janela e transparente e fica
// sempre no topo, o compositor do Windows tambem redesenha junto.
//
// O que faz: adota toda animacao CSS infinita, pausa, e avanca o tempo dela na
// mao, poucas vezes por segundo. O desenho continua sendo o do CSS (mesmos
// keyframes, mesmas curvas, mesmos atrasos) — so muda quantos quadros por
// segundo sao pintados. Animacoes de uma vez so (capacete caindo, aceno) e
// transitions nao sao tocadas: duram menos de 2s e rodam em taxa cheia.
//
// A taxa vem de <html data-anim-fps="N">; sem o atributo, 24.
;(function () {
  const fps = Number(document.documentElement.dataset.animFps) || 24
  const origin = new WeakMap() // animacao -> instante (ms) em que ela "comecou"

  function tick() {
    const now = performance.now()
    for (const anim of document.getAnimations()) {
      if (!(anim instanceof CSSAnimation)) continue
      if (anim.effect.getComputedTiming().iterations !== Infinity) continue
      let t0 = origin.get(anim)
      if (t0 === undefined) {
        // recem-criada (troca de estado): assume o ponto em que ela ja estava
        t0 = now - (Number(anim.currentTime) || 0)
        origin.set(anim, t0)
        anim.pause()
      }
      anim.currentTime = now - t0
    }
  }

  // --- animacoes embutidas no SVG (SMIL: <animateTransform> e afins) ---------
  // Elas nao aparecem em document.getAnimations() e tem um agravante: continuam
  // girando com o elemento INVISIVEL. As engrenagens do painel so aparecem na
  // tela de configuracoes (opacity: 0 no resto do tempo), mas custavam ~40% de
  // um nucleo o dia inteiro. Aqui cada <svg> com SMIL e pausado e so anda —
  // na mesma taxa reduzida — enquanto algum alvo animado esta de fato visivel.
  const SMIL = 'animate, animateTransform, animateMotion, set'
  const smilRoots = [...document.querySelectorAll('svg')]
    .filter((svg) => !svg.ownerSVGElement && svg.querySelector(SMIL))
    .map((svg) => {
      svg.pauseAnimations()
      const targets = [...svg.querySelectorAll(SMIL)].map((a) => a.targetElement || a.parentElement)
      return { svg, targets, last: performance.now() }
    })

  const shown = (node) =>
    !!node && node.checkVisibility({ opacityProperty: true, visibilityProperty: true })

  function tickSmil() {
    const now = performance.now()
    for (const r of smilRoots) {
      if (r.targets.some(shown)) r.svg.setCurrentTime(r.svg.getCurrentTime() + (now - r.last) / 1000)
      r.last = now
    }
  }

  tick()
  setInterval(() => {
    tick()
    tickSmil()
  }, 1000 / fps)
})()
