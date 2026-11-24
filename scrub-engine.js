/* ============================================================================
   scroll-world — portable scroll-scrubbed camera-flight engine
   ----------------------------------------------------------------------------
   Framework-agnostic. Vanilla JS, zero dependencies. It builds its own DOM and
   injects its own (namespaced) CSS into a container you give it, so it drops into
   plain HTML, Next.js (call from a ref/useEffect), Vue (onMounted), a server-
   rendered page, anything.

   USAGE
     mountScrollWorld(document.getElementById('world'), {
       brand: { name: 'Pearl & Co.', href: '#top' },
       diveScroll: 1.3,   // viewport-heights of scroll per dive clip
       connScroll: 0.9,   // ...per connector clip
       hint: 'scroll to fly in',
       nav: true,         // show the top section nav
       atmosphere: true,  // subtle gradient + drifting particles behind the clips
       sections: [
         { id, label, still, stillMobile, clip, clipMobile, accent,
           scroll: 1.6,   // optional per-section override of diveScroll — more scroll
                          // distance = a slower, longer dwell in this scene
           linger: 0.5,   // optional 0..1 — remaps time so the camera settles mid-scene
                          // (exactly where the copy peaks) and moves quicker at the
                          // edges. 0 = linear (default). Keep ≤ 0.6; 1 = full pause.
           eyebrow, title, body, tags:[…],
           cta:{ primary:{label,href}, secondary:{label,href} } }, // last section only
         …
       ],
       connectors: [clipUrl, …],          // length = sections.length - 1 (nulls allowed)
       connectorsMobile: [clipUrl, …],    // optional lighter connectors for phones (same length)

   MOBILE (the clipMobile/connectorsMobile variants are the opt-in mobile version;
   the rest of the phone handling below is always on)
     The engine is phone-aware out of the box: on a coarse-pointer / ≤860px viewport it
       - loads `clipMobile` / `connectorsMobile` when provided (encode these smaller +
         tighter-GOP — seek cost on a phone decoder is dominated by frames-from-keyframe,
         so a 720p, -g 4 file scrubs far smoother than the 1080p desktop master; see
         pipeline.md). Falls back to the desktop `clip` if no mobile variant is given.
       - uses `stillMobile` as the scene poster when provided (pair it with native 9:16
         clipMobile renders so the poster matches the portrait video's first frame instead
         of flashing from a landscape crop). Chosen once at mount; a desktop resize into
         phone width keeps the desktop poster (clips still switch via isMobile()).
       - coalesces seeks (never issues a new currentTime while the decoder is still
         `seeking`) so fast flicks can't pile up and freeze the video.
       - keeps the still as a live poster until the clip actually paints its first frame,
         and primes each video (muted play→pause) on first touch — this is what stops iOS
         from showing a blank scene before the first seek.
       - drops the drifting particles and ignores URL-bar-only resizes (no scroll jump).
     Nothing here is required — a config with only `clip`/`connectors` still works on
     phones; the mobile variants just make it lighter and smoother.

   THEME (CSS custom properties; set on the container or :root to override)
     --sw-bg         page background (match your scene bg for seamless posters)
     --sw-ink        primary text
     --sw-ink-soft   secondary text
     --sw-accent     default accent (each section overrides via its `accent`)
     --sw-font-display / --sw-font-body

   REQUIREMENTS ON YOUR ASSETS
     - clips encoded native-res, crf~20, -g 8, +faststart, no audio (see pipeline.md)
     - connectors' endpoints are the neighbouring dives' ACTUAL frames (see SKILL Step 5)
     - (optional) mobile variants at ~720p, -g 4 for smoother phone scrubbing
   The engine loads each clip as a Blob (always seekable) and scrubs currentTime; it does
   NOT depend on HTTP byte-range support.
   ========================================================================== */

function splitWords(text) {
  return text.split(' ').map(w => `<span class="amx-word-mask"><span class="amx-word">${w}</span></span>`).join(' ');
}

function mountScrollWorld(container, config) {
  const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  // Phone detection. `coarse` is captured once (input type doesn't change mid-session);
  // the ≤860px query is read live via isMobile() so a desktop resize/DevTools toggle
  // switches sources and seek behaviour without a reload.
  const coarse = window.matchMedia('(hover: none) and (pointer: coarse)').matches;
  const smallMQ = window.matchMedia('(max-width: 860px)');
  const isMobile = () => coarse || smallMQ.matches;
  const SECTIONS = config.sections || [];
  const CONNECTORS = config.connectors || [];
  const CONNECTORS_M = config.connectorsMobile || [];
  const DIVE_W = config.diveScroll || 1.3;
  const CONN_W = config.connScroll || 0.9;
  const CROSSFADE = (config.crossfade != null) ? config.crossfade : 0.12;  // seam dissolve width (vh)
  const N = SECTIONS.length;
  if (!N) return;

  injectCSS();
  container.classList.add('sw-root');

  // ---- build the interleaved segment chain: dive0, conn0, dive1, … diveN-1 ----
  const SEGMENTS = [];
  SECTIONS.forEach((s, i) => {
    const dive = { kind: 'dive', si: i, clip: s.clip, clipM: s.clipMobile, still: s.still, stillM: s.stillMobile,
                   idleClip: s.idleClip, accent: s.accent, w: s.scroll || DIVE_W, linger: s.linger || 0 };
    SEGMENTS.push(dive);
    s._seg = dive;
    // A connector is optional: if connectors[i] is falsy, the two dives simply
    // crossfade directly (no fly-over). Lets a page complete even when a
    // connector can't be generated (e.g. a content-filter false-positive).
    if (i < N - 1 && CONNECTORS[i]) {
      SEGMENTS.push({ kind: 'conn', si: i, clip: CONNECTORS[i], clipM: CONNECTORS_M[i],
                      still: SECTIONS[i + 1].still, stillM: SECTIONS[i + 1].stillMobile,
                      accent: SECTIONS[i + 1].accent, w: CONN_W });
    }
  });
  const NSEG = SEGMENTS.length;

  // ---- DOM ----
  const sky = el('div', 'sw-sky');
  if (config.atmosphere !== false) {
    sky.appendChild(el('div', 'sw-sky__grad'));
    sky.appendChild(el('div', 'sw-sky__glow'));
  }
  const particles = el('div', 'sw-particles'); sky.appendChild(particles);

  const scrollbar = el('div', 'sw-scrollbar');
  const scrollbarFill = el('span'); scrollbar.appendChild(scrollbarFill);

  const topbar = el('div', 'sw-topbar');
  if (config.brand) {
    const brand = el('a', 'sw-brand'); brand.href = (config.brand.href || '#');
    brand.appendChild(el('span', 'sw-brand__mark'));
    const nm = el('span', 'sw-brand__name'); nm.textContent = config.brand.name || ''; brand.appendChild(nm);
    brand.addEventListener('click', (e) => {
      e.preventDefault();
      jumpTo('hero');
    });
    topbar.appendChild(brand);
  }
  const nav = el('nav', 'sw-nav'); if (config.nav !== false) topbar.appendChild(nav);
  if (config.cta && config.cta.label) {
    const c = el('a', 'sw-topcta'); c.href = config.cta.href || '#'; c.textContent = config.cta.label;
    c.addEventListener('click', (e) => {
      e.preventDefault();
      if (typeof window.openConfidentialInquiry === 'function') {
        window.openConfidentialInquiry();
      } else {
        jumpTo(N - 1);
      }
    });
    topbar.appendChild(c);
  }

  const stage = el('div', 'sw-stage');
  const copylayer = el('div', 'sw-copylayer');
  const route = el('div', 'sw-route');
  const hint = el('div', 'sw-hint');
  const hintText = el('span'); hintText.textContent = config.hint || 'scroll'; hint.appendChild(hintText);
  hint.appendChild(el('i'));
  const track = el('div', 'sw-track');

  [sky, scrollbar, topbar, stage, copylayer, route, hint, track].forEach(n => container.appendChild(n));

  // segment scenes
  SEGMENTS.forEach(s => {
    const scene = el('div', 'sw-scene'); scene.style.setProperty('--sw-accent', s.accent || '');
    const img = el('img', 'sw-scene__still'); img.alt = ''; img.decoding = 'async'; img.loading = 'lazy';
    const poster = (isMobile() && s.stillM) ? s.stillM : s.still;
    if (poster) img.src = poster;
    scene.appendChild(img); stage.appendChild(scene);
    s.el = scene; s.img = img; s.video = null; s.hasClip = false;
    s.idleVideo = null; s.hasIdle = false;
    s.loading = false; s.ready = false; s.cur = 0; s.target = 0; s.visible = false;
  });

  // per-section copy / route / nav / figures
  const copies = [], figures = [], dots = [];

  let heroEl = null;
  const HERO_W = config.hero ? (config.heroScroll || 1.15) : 0;
  if (config.hero) {
    const h = config.hero;
    heroEl = el('section', 'sw-hero');
    heroEl.innerHTML =
      `<div class="sw-hero__backdrop-gradient"></div>` +
      `<div class="sw-hero__content">` +
        `<div class="sw-hero__meta">` +
          `<span class="sw-hero__coords">${esc(h.coords || 'ARGYLL & BUTE · SCOTLAND // 56°14\'N 05°08\'W')}</span>` +
          `<span class="sw-hero__edition">${esc(h.elevation || '820M ELEVATION · PRIVATE TREATY')}</span>` +
        `</div>` +
        `<div class="sw-hero__title-wrap">` +
          `<h1 class="sw-hero__title">${(h.title || 'AURA\nHIGHLANDS').split('\n').map(line => `<span class="sw-hero__title-line">${splitWords(esc(line))}</span>`).join('')}</h1>` +
        `</div>` +
        `<div class="sw-hero__bottom">` +
          `<button class="sw-hero__explore" id="swHeroCta">` +
            `<span class="sw-hero__explore-bracket">[</span>` +
            `<span class="sw-hero__explore-text">${esc(h.cta || 'EXPLORE MONOGRAPH')}</span>` +
            `<span class="sw-hero__explore-arrow">↓</span>` +
            `<span class="sw-hero__explore-bracket">]</span>` +
          `</button>` +
          `<div class="sw-hero__descriptor">` +
            `<span>${esc(h.descriptor || 'MONOLITHIC RESIDENCY CUT INTO SCHIST BEDROCK')}</span>` +
            `<span class="sw-hero__descriptor-num">${esc(h.sub || 'FIVE SPATIAL VOLUMES // LOT 01')}</span>` +
          `</div>` +
        `</div>` +
      `</div>`;
    copylayer.appendChild(heroEl);

    const ctaBtn = heroEl.querySelector('#swHeroCta');
    if (ctaBtn) {
      ctaBtn.addEventListener('click', (e) => {
        e.preventDefault();
        jumpTo(0);
      });
    }
  }

  copylayer.addEventListener('click', (e) => {
    const target = e.target.closest('[data-action]');
    if (!target) return;
    const action = target.getAttribute('data-action');
    if (action === 'inquire') {
      e.preventDefault();
      if (typeof window.openConfidentialInquiry === 'function') {
        window.openConfidentialInquiry();
      }
    } else if (action === 'specs') {
      e.preventDefault();
      if (typeof window.openArchitecturalSpecs === 'function') {
        window.openArchitecturalSpecs();
      }
    }
  });

  SECTIONS.forEach((s, i) => {
    const c = el('article', 'sw-copy'); c.style.setProperty('--sw-accent', s.accent || '');
    c.innerHTML =
      (s.title ? `<h2 class="sw-copy__title">${splitWords(esc(s.title))}</h2>` : '') +
      (s.body ? `<p class="sw-copy__body">${esc(s.body)}</p>` : '') +
      (s.tags && s.tags.length ? `<ul class="sw-copy__tags">${s.tags.map(t => `<li>${esc(t)}</li>`).join('')}</ul>` : '') +
      (s.cta ? `<div class="sw-copy__cta">${ctaBtns(s.cta)}</div>` : '');
    copylayer.appendChild(c); copies.push(c);

    let fig = null;
    if (s.inset) {
      fig = el('aside', 'sw-figure');
      fig.setAttribute('data-full', s.inset.full || s.inset.img);
      fig.setAttribute('data-label', s.inset.label || '');
      fig.setAttribute('data-spec', s.inset.spec || '');
      fig.innerHTML =
        `<div class="sw-figure__frame">` +
          `<img src="${esc(s.inset.img)}" alt="${esc(s.inset.label || '')}" loading="lazy" />` +
          `<span class="sw-figure__badge">[+] 2K ARCHIVE</span>` +
        `</div>` +
        `<div class="sw-figure__meta">` +
          `<span class="sw-figure__label">${esc(s.inset.label || '')}</span>` +
          (s.inset.spec ? `<span class="sw-figure__spec">${esc(s.inset.spec)}</span>` : '') +
        `</div>`;
      fig.addEventListener('click', () => {
        if (typeof window.openArchitecturalLightbox === 'function') {
          window.openArchitecturalLightbox(s.inset.full || s.inset.img, s.inset.label, s.inset.spec);
        }
      });
      copylayer.appendChild(fig);
      if (window.gsap && !reduce) {
        gsap.set(fig, { opacity: 0, x: 28, scale: 0.98 });
      }
    }
    figures.push(fig);

    const dot = el('button', 'sw-route__dot'); dot.style.setProperty('--sw-accent', s.accent || '');
    dot.innerHTML = `<span class="sw-route__label">${esc(s.label || '')}</span><i></i>`;
    dot.addEventListener('click', () => jumpTo(i)); route.appendChild(dot); dots.push(dot);

    if (config.nav !== false) {
      const b = el('button', 'sw-nav__item'); b.textContent = s.label || '';
      b.addEventListener('click', () => jumpTo(i)); nav.appendChild(b);
    }

    if (window.gsap && !reduce) {
      c.style.opacity = '0';
      const words = c.querySelectorAll('.amx-word');
      const body = c.querySelector('.sw-copy__body');
      const tags = c.querySelectorAll('.sw-copy__tags li');
      const cta = c.querySelector('.sw-copy__cta');
      if (words && words.length) gsap.set(words, { yPercent: 110, opacity: 0 });
      if (body) gsap.set(body, { opacity: 0, y: 14 });
      if (tags.length) gsap.set(tags, { opacity: 0, y: 8 });
      if (cta) gsap.set(cta, { opacity: 0, y: 14 });
    }
  });

  // ---- math ----
  const clamp = (x, a = 0, b = 1) => Math.min(b, Math.max(a, x));
  const smooth = x => { x = clamp(x); return x * x * (3 - 2 * x); };
  // Per-section dwell: monotone remap of scroll→time so the camera settles mid-scene
  // (where the copy peaks) and moves quicker near the seams. L=0 linear, L=1 full
  // mid-scene pause. f(0)=0, f(1)=1 always, so seam frames are untouched.
  const lingerEase = (x, L) => { L = clamp(L); const c = x - 0.5; return (1 - L) * x + L * (4 * c * c * c + 0.5); };
  let vh = window.innerHeight, stageX = 0, totalW = 0, activeIndex = -1, ticking = false;
  let laidOutW = window.innerWidth;   // width the current layout was computed at (see onResize)

  function layout() {
    vh = window.innerHeight;
    laidOutW = window.innerWidth;
    stageX = window.innerWidth > 860 ? 4 : 0;
    let off = HERO_W;
    SEGMENTS.forEach(s => { s.start = off * vh; off += s.w; s.end = off * vh; });
    totalW = off;
    track.style.height = (totalW * vh + vh) + 'px';   // +1vh so the last flight completes
    read();
  }

  function jumpTo(i) {
    if (i === -1 || i === 'hero') {
      if (window.lenis) window.lenis.scrollTo(0, { duration: 1.4 });
      else window.scrollTo({ top: 0, behavior: reduce ? 'auto' : 'smooth' });
      return;
    }
    const seg = SECTIONS[i]._seg;
    const target = seg.start + (seg.end - seg.start) * 0.45;
    if (window.lenis) {
      window.lenis.scrollTo(target, { duration: 1.4 });
    } else {
      window.scrollTo({ top: target, behavior: reduce ? 'auto' : 'smooth' });
    }
  }

  function loadClip(s) {
    // Under prefers-reduced-motion we never load the clips at all — the stills stay up
    // and simply cross-dissolve as you scroll. No scrubbed video motion, no decode cost.
    if (reduce || s.loading || !s.clip) return;
    s.loading = true;

    // Load idle video overlay if provided for this scene
    if (s.idleClip && !s.idleVideo) {
      const iv = document.createElement('video');
      iv.className = 'sw-scene__idle';
      iv.muted = true; iv.loop = true; iv.playsInline = true; iv.preload = 'auto';
      iv.setAttribute('muted', ''); iv.setAttribute('loop', ''); iv.setAttribute('playsinline', '');
      iv.src = s.idleClip;
      s.el.appendChild(iv);
      s.idleVideo = iv;
      s.hasIdle = true;
    }

    // Serve the lighter mobile encode on phones when one was provided.
    const url = (isMobile() && s.clipM) ? s.clipM : s.clip;
    fetch(url).then(r => r.ok ? r.blob() : Promise.reject(new Error('404')))
      .then(blob => {
        const v = document.createElement('video');
        v.className = 'sw-scene__video';
        v.muted = true; v.playsInline = true; v.preload = 'auto';
        v.setAttribute('muted', ''); v.setAttribute('playsinline', '');
        v.src = URL.createObjectURL(blob);
        v.addEventListener('loadedmetadata', () => { s.ready = true; read(); });
        // Reveal the video (hide the still poster) only once a real frame has
        // painted — on iOS a seeked-but-never-played muted video stays blank, so
        // hiding the still on metadata alone would flash an empty scene.
        v.addEventListener('seeked', () => { s.el.classList.add('has-clip'); }, { once: true });
        v.addEventListener('loadeddata', () => { try { v.pause(); } catch (e) {} if (userReady) primeVideo(v); });
        s.el.appendChild(v); s.video = v; s.hasClip = true;
      }).catch(() => { s.loading = false; });
  }

  function read() {
    const y = window.scrollY || window.pageYOffset;
    const fade = CROSSFADE * vh;
    let ci = 0;
    for (let i = 0; i < NSEG; i++) if (y >= SEGMENTS[i].start) ci = i;

    for (let i = 0; i < NSEG; i++) {
      const s = SEGMENTS[i];
      if (y > s.start - 1.6 * vh && y < s.end + 1.6 * vh) loadClip(s);
      const local = clamp((y - s.start) / (s.end - s.start), 0, 1);
      s.target = s.linger ? lingerEase(local, s.linger) : local;
      let outside = 0;
      if (i === 0 && HERO_W > 0 && y <= s.start) outside = 0;
      else if (y < s.start) outside = s.start - y;
      else if (y > s.end) outside = y - s.end;
      const op = smooth(1 - outside / fade);
      s.el.style.opacity = op; s.visible = op > 0.001;
      s.el.style.zIndex = (i === ci) ? '120' : String(100 + Math.round(op * 10));
      if (!s.hasClip || !s.ready) {
        const sc = reduce ? 1 : 1.03 + local * 0.14;
        s.img.style.transform = `translateX(${stageX - 2}vw) scale(${sc.toFixed(3)})`;
      }
      if (s.hasIdle && s.idleVideo) {
        // Zero transition: instantaneous swap when resting at terminal frame
        const isEnd = local >= 0.985;
        s.idleVideo.style.opacity = isEnd ? '1' : '0';
        if (isEnd) {
          if (s.idleVideo.paused) { s.idleVideo.play().catch(() => {}); }
        } else {
          if (!s.idleVideo.paused) { s.idleVideo.pause(); }
        }
      }
    }

    if (heroEl) {
      const heroMaxY = HERO_W * vh;
      const heroProgress = clamp(y / (heroMaxY || 1), 0, 1);
      const heroOp = clamp(1 - heroProgress / 0.65, 0, 1);
      heroEl.style.opacity = heroOp;
      heroEl.style.pointerEvents = heroOp > 0.2 ? 'auto' : 'none';

      if (window.gsap && !reduce) {
        const content = heroEl.querySelector('.sw-hero__content');
        if (content) {
          content.style.transform = `translateY(${-heroProgress * 60}px)`;
        }
      }
    }

    for (let i = 0; i < N; i++) {
      const seg = SECTIONS[i]._seg;
      const pr = clamp((y - seg.start) / (seg.end - seg.start), 0, 1);
      const before = y < seg.start, after = y > seg.end;
      let cop;
      if (i === 0) {
        if (HERO_W > 0) {
          cop = (before || after) ? 0 : smooth(1 - Math.abs(pr - 0.5) / 0.5);
        } else {
          cop = after ? 0 : smooth(1 - pr / 0.62);
        }
      }
      else if (i === N - 1) cop = before ? 0 : smooth(pr / 0.4);       // holds CTA at the end
      else cop = (before || after) ? 0 : smooth(1 - Math.abs(pr - 0.5) / 0.5);
      const c = copies[i];

      if (window.gsap && !reduce) {
        c.style.pointerEvents = cop > 0.4 ? 'auto' : 'none';
        const shouldBeActive = cop > 0.28;
        if (shouldBeActive && !c._active) {
          c._active = true;
          c.style.opacity = '1';
          const tl = gsap.timeline({ overwrite: 'auto' });
          const title = c.querySelector('.sw-copy__title');
          const body = c.querySelector('.sw-copy__body');
          const tags = c.querySelectorAll('.sw-copy__tags li');
          const cta = c.querySelector('.sw-copy__cta');

          const words = c.querySelectorAll('.amx-word');
          if (words && words.length) {
            tl.fromTo(words, { yPercent: 110, opacity: 0 }, { yPercent: 0, opacity: 1, duration: 0.38, stagger: 0.024, ease: 'power4.out' }, 0);
          } else if (title) {
            tl.fromTo(title, { opacity: 0, y: 24 }, { opacity: 1, y: 0, duration: 0.38, ease: 'power3.out' }, 0);
          }
          if (body) tl.fromTo(body, { opacity: 0, y: 14 }, { opacity: 1, y: 0, duration: 0.28, ease: 'power2.out' }, 0.12);
          if (tags && tags.length) tl.fromTo(tags, { opacity: 0, y: 8 }, { opacity: 1, y: 0, stagger: 0.03, duration: 0.22, ease: 'power2.out' }, 0.18);
          if (cta) tl.fromTo(cta, { opacity: 0, y: 14 }, { opacity: 1, y: 0, duration: 0.26, ease: 'power2.out' }, 0.22);

          if (figures[i]) {
            gsap.to(figures[i], { opacity: 1, x: 0, scale: 1, duration: 0.45, ease: 'power3.out', overwrite: 'auto' });
          }
        } else if (!shouldBeActive && c._active) {
          c._active = false;
          const tl = gsap.timeline({
            overwrite: 'auto',
            onComplete: () => { if (!c._active) c.style.opacity = '0'; }
          });
          const title = c.querySelector('.sw-copy__title');
          const words = c.querySelectorAll('.amx-word');
          const body = c.querySelector('.sw-copy__body');
          const tags = c.querySelectorAll('.sw-copy__tags li');
          const cta = c.querySelector('.sw-copy__cta');

          if (words && words.length) {
            tl.to(words, { yPercent: -100, opacity: 0, duration: 0.18, stagger: 0.012, ease: 'power2.in' }, 0);
          } else if (title) {
            tl.to(title, { opacity: 0, y: -16, duration: 0.18, ease: 'power2.in' }, 0);
          }
          if (body) tl.to(body, { opacity: 0, y: -12, duration: 0.16, ease: 'power2.in' }, 0.02);
          if (tags && tags.length) tl.to(tags, { opacity: 0, y: -8, duration: 0.14 }, 0.04);
          if (cta) tl.to(cta, { opacity: 0, duration: 0.12 }, 0);

          if (figures[i]) {
            gsap.to(figures[i], { opacity: 0, x: 20, scale: 0.98, duration: 0.22, ease: 'power2.in', overwrite: 'auto' });
          }
        }
      } else {
        c.style.opacity = cop;
        c.style.transform = reduce ? 'none' : `translateY(${(0.5 - pr) * 4}vh)`;
        c.style.pointerEvents = cop > 0.5 ? 'auto' : 'none';
        if (figures[i]) {
          figures[i].style.opacity = cop;
          figures[i].style.pointerEvents = cop > 0.5 ? 'auto' : 'none';
        }
      }
    }

    const cur = SEGMENTS[ci];
    let near = clamp(cur.kind === 'dive' ? cur.si
      : (((y - cur.start) / (cur.end - cur.start)) > 0.5 ? cur.si + 1 : cur.si), 0, N - 1);
    if (HERO_W > 0 && y < HERO_W * vh * 0.65) {
      near = -1;
    }
    if (near !== activeIndex) {
      activeIndex = near;
      dots.forEach((d, k) => {
        d.classList.toggle('is-active', k === near);
        if (window.gsap && !reduce) {
          const dotI = d.querySelector('i');
          if (dotI) {
            if (k === near) {
              gsap.to(dotI, { scale: 1.45, duration: 0.4, ease: 'back.out(2)' });
            } else {
              gsap.to(dotI, { scale: 1, duration: 0.3, ease: 'power2.out' });
            }
          }
        }
      });
      nav.querySelectorAll('.sw-nav__item').forEach((n, k) => n.classList.toggle('is-active', k === near));
      if (near >= 0) {
        container.style.setProperty('--sw-accent', SECTIONS[near].accent || '');
        if (typeof config.onSectionChange === 'function') {
          config.onSectionChange(near, SECTIONS[near]);
        }
      }
    }
    const currentProgress = clamp(y / (totalW * vh));
    scrollbarFill.style.transform = `scaleX(${currentProgress})`;
    if (typeof config.onProgress === 'function') {
      config.onProgress(currentProgress, y);
    }
    hint.style.opacity = clamp(1 - y / (0.5 * vh));
    if (particles) particles.style.transform = `translate3d(0, ${-y * 0.05}px, 0)`;
    ticking = false;
  }

  function raf() {
    const eps = isMobile() ? 0.02 : 0.008;   // coarser seek step on phones = fewer decodes
    for (let i = 0; i < NSEG; i++) {
      const s = SEGMENTS[i];
      if (!s.hasClip || !s.ready || !s.video) continue;
      // Never queue a seek while the decoder is still resolving the last one.
      // On phones a fast flick would otherwise pile up seeks and freeze the clip;
      // cur keeps lerping, so we snap to the latest target the moment it's free.
      if (s.video.seeking) continue;
      if (!s.visible && Math.abs(s.cur - s.target) < 0.002) continue;
      s.cur += (s.target - s.cur) * (reduce ? 1 : 0.18);
      const dur = s.video.duration || 1;
      const t = clamp(s.cur, 0, 0.999) * dur;
      if (Math.abs(s.video.currentTime - t) > eps) { try { s.video.currentTime = t; } catch (e) {} }
    }
    requestAnimationFrame(raf);
  }

  // iOS needs a user gesture before a muted video will decode/paint reliably. On the
  // first touch we prime every loaded clip (muted play→pause) so the first seek is
  // instant instead of showing a blank frame. `userReady` also makes freshly-loaded
  // clips prime themselves (see loadClip).
  let userReady = false;
  function primeVideo(v) {
    if (!isMobile() || !v) return;
    try { const p = v.play(); if (p && p.then) p.then(() => { try { v.pause(); } catch (e) {} }).catch(() => {}); }
    catch (e) {}
  }
  function onFirstGesture() {
    if (userReady) return;
    userReady = true;
    SEGMENTS.forEach(s => primeVideo(s.video));
  }
  window.addEventListener('pointerdown', onFirstGesture, { once: true, passive: true });
  window.addEventListener('touchstart', onFirstGesture, { once: true, passive: true });

  // Particles are a per-frame cost we can't afford alongside video scrubbing on a phone.
  seedParticles(particles, reduce || coarse);
  window.addEventListener('scroll', () => { if (!ticking) { ticking = true; requestAnimationFrame(read); } }, { passive: true });
  // Mobile browsers fire `resize` every time the URL bar slides in/out. Re-running
  // layout() there rebuilds the track height and yanks the scroll position, so on
  // touch we ignore height-only changes and only relayout when the width actually
  // changes (rotation still comes through orientationchange). layout() records the
  // width it laid out at.
  function onResize() {
    if (coarse && window.innerWidth === laidOutW) return;
    layout();
  }
  window.addEventListener('resize', onResize);
  window.addEventListener('orientationchange', layout);
  window.addEventListener('load', layout);
  layout();
  requestAnimationFrame(raf);

  // ---- helpers ----
  function el(tag, cls) { const n = document.createElement(tag); if (cls) n.className = cls; return n; }
  function pad(n) { return String(n).padStart(2, '0'); }
  function esc(s) { return String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }
  function ctaBtns(cta) {
    let h = '';
    if (cta.primary) h += `<a class="sw-btn sw-btn--primary" href="${esc(cta.primary.href || '#')}" data-action="inquire">${esc(cta.primary.label)}</a>`;
    if (cta.secondary) h += `<a class="sw-btn sw-btn--ghost" href="${esc(cta.secondary.href || '#')}" data-action="specs">${esc(cta.secondary.label)}</a>`;
    return h;
  }
}

function seedParticles(host, reduce) {
  if (!host || reduce) return;
  const kinds = ['dot', 'dot', 'ring'];
  const seeds = [7, 23, 41, 58, 71, 88, 12, 34, 52, 66, 83, 95, 18, 29, 47, 63, 77, 91, 5, 38, 55, 69, 82, 97];
  for (let k = 0; k < 20; k++) {
    const s = document.createElement('span');
    s.className = 'sw-pt sw-pt--' + kinds[k % kinds.length];
    s.style.left = seeds[k % seeds.length] + 'vw';
    s.style.top = ((seeds[(k * 3) % seeds.length] * 1.3) % 100) + 'vh';
    s.style.setProperty('--sw-sc', (0.5 + ((seeds[(k * 5) % seeds.length] % 60) / 60) * 1.1).toFixed(2));
    const dur = 14 + (seeds[(k * 7) % seeds.length] % 22);
    s.style.animationDuration = dur + 's';
    s.style.animationDelay = (-(seeds[(k * 2) % seeds.length] % dur)) + 's';
    host.appendChild(s);
  }
}

function injectCSS() {
  if (document.getElementById('sw-css')) return;
  const css = `
  .sw-root{--sw-bg:#F5EDE0;--sw-ink:#241d2b;--sw-ink-soft:#6a6072;--sw-accent:#8a7bb5;
    --sw-font-display:ui-rounded,"SF Pro Rounded","Segoe UI",system-ui,sans-serif;
    --sw-font-body:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,system-ui,sans-serif;
    color:var(--sw-ink);font-family:var(--sw-font-body);}
  html,body{margin:0;background:var(--sw-bg,#F5EDE0);overflow-x:hidden;}
  .sw-sky{position:fixed;inset:0;z-index:0;overflow:hidden;pointer-events:none;background:var(--sw-bg);}
  .sw-sky__grad{position:absolute;inset:-10%;background:linear-gradient(178deg,color-mix(in srgb,var(--sw-accent) 12%,var(--sw-bg)) 0%,var(--sw-bg) 55%,color-mix(in srgb,var(--sw-accent) 6%,var(--sw-bg)) 100%);}
  .sw-sky__glow{position:absolute;inset:0;background:radial-gradient(60% 42% at 74% 16%,color-mix(in srgb,var(--sw-accent) 22%,transparent),transparent 70%),radial-gradient(46% 34% at 50% 50%,color-mix(in srgb,#fff 45%,transparent),transparent 70%);}
  .sw-particles{position:absolute;inset:-6% -2%;will-change:transform;}
  .sw-pt{position:absolute;width:13px;height:13px;transform:scale(var(--sw-sc,1));opacity:0;animation:sw-drift linear infinite;}
  .sw-pt::before{content:"";position:absolute;inset:0;border-radius:50%;}
  .sw-pt--dot::before{background:radial-gradient(circle at 34% 30%,color-mix(in srgb,var(--sw-accent) 60%,#000),#000 82%);}
  .sw-pt--ring::before{background:transparent;border:2px solid color-mix(in srgb,var(--sw-accent) 55%,transparent);}
  @keyframes sw-drift{0%{opacity:0;transform:scale(var(--sw-sc)) translate(0,12vh) rotate(0)}12%{opacity:.5}88%{opacity:.45}100%{opacity:0;transform:scale(var(--sw-sc)) translate(4vw,-22vh) rotate(210deg)}}
  .sw-scrollbar{position:fixed;top:0;left:0;right:0;height:3px;z-index:60;background:color-mix(in srgb,var(--sw-accent) 14%,transparent);}
  .sw-scrollbar span{display:block;height:100%;width:100%;transform-origin:0 50%;transform:scaleX(0);background:var(--sw-accent);}
  .sw-topbar{position:fixed;top:0;left:0;right:0;z-index:50;display:flex;align-items:center;justify-content:space-between;gap:16px;padding:clamp(14px,2.4vw,26px) clamp(18px,5vw,64px);}
  .sw-brand{display:flex;align-items:center;gap:10px;text-decoration:none;color:var(--sw-ink);}
  .sw-brand__mark{width:24px;height:28px;border-radius:7px 7px 10px 10px;background:linear-gradient(160deg,var(--sw-accent),color-mix(in srgb,var(--sw-accent) 60%,#000));box-shadow:0 6px 14px color-mix(in srgb,var(--sw-accent) 40%,transparent);}
  .sw-brand__name{font-family:var(--sw-font-display);font-weight:700;font-size:1.1rem;}
  .sw-nav{display:flex;gap:4px;padding:5px;background:color-mix(in srgb,#fff 55%,transparent);backdrop-filter:blur(10px);border:1px solid color-mix(in srgb,var(--sw-accent) 16%,transparent);border-radius:999px;}
  .sw-nav__item{font:inherit;font-size:.82rem;color:var(--sw-ink-soft);border:0;background:transparent;cursor:pointer;padding:7px 14px;border-radius:999px;transition:color .25s,background .25s;}
  .sw-nav__item:hover{color:var(--sw-ink);} .sw-nav__item.is-active{color:#fff;background:var(--sw-accent);}
  .sw-topcta{text-decoration:none;font-weight:600;font-size:.9rem;color:#fff;background:var(--sw-ink);padding:10px 20px;border-radius:999px;white-space:nowrap;}
  .sw-stage{position:fixed;inset:0;z-index:10;pointer-events:none;}
  .sw-scene{position:absolute;inset:0;opacity:0;overflow:hidden;will-change:opacity;}
  .sw-scene__video,.sw-scene__still,.sw-scene__idle{position:absolute;inset:0;width:100%;height:100%;object-fit:cover;object-position:center 42%;}
  .sw-scene__still{will-change:transform;} .sw-scene.has-clip .sw-scene__still{opacity:0;} .sw-scene__video{z-index:1;}
  .sw-scene__idle{opacity:0;z-index:2;pointer-events:none;}
  .sw-figure{position:absolute;right:clamp(56px,7vw,130px);top:50%;transform:translateY(-50%);width:min(32vw,440px);z-index:25;pointer-events:auto;cursor:pointer;border:1px solid var(--border,rgba(237,237,237,0.15));background:rgba(12,12,12,0.8);backdrop-filter:blur(16px);-webkit-backdrop-filter:blur(16px);border-radius:4px;overflow:hidden;box-shadow:0 24px 60px rgba(0,0,0,0.65),0 0 0 1px rgba(255,255,255,0.05) inset;opacity:0;will-change:transform,opacity;transition:border-color .3s,box-shadow .3s;}
  .sw-figure:hover{border-color:rgba(237,237,237,0.35);box-shadow:0 28px 70px rgba(0,0,0,0.8),0 0 0 1px rgba(255,255,255,0.1) inset;}
  .sw-figure__frame{width:100%;aspect-ratio:16/10;overflow:hidden;background:#000;position:relative;}
  .sw-figure__badge{position:absolute;top:8px;right:8px;font-family:ui-monospace,Menlo,monospace;font-size:.6rem;letter-spacing:.08em;padding:3px 7px;background:rgba(10,10,10,0.78);border:1px solid var(--border,rgba(237,237,237,0.2));border-radius:2px;color:var(--sw-ink-soft,#888);backdrop-filter:blur(8px);pointer-events:none;transition:color .2s,border-color .2s,background .2s;}
  .sw-figure:hover .sw-figure__badge{color:var(--sw-ink,#ededed);border-color:rgba(237,237,237,0.4);background:rgba(10,10,10,0.92);}
  .sw-figure__frame img{width:100%;height:100%;object-fit:cover;display:block;transition:transform .6s cubic-bezier(0.16,1,0.3,1);}
  .sw-figure:hover .sw-figure__frame img{transform:scale(1.04);}
  .sw-figure__meta{padding:10px 14px;display:flex;justify-content:space-between;align-items:center;gap:12px;font-family:ui-monospace,Menlo,monospace;font-size:.68rem;letter-spacing:.08em;text-transform:uppercase;border-top:1px solid var(--border,rgba(237,237,237,0.1));background:rgba(10,10,10,0.6);}
  .sw-figure__label{color:var(--sw-ink,#ededed);font-weight:600;}
  .sw-figure__spec{color:var(--sw-ink-soft,#888);font-size:.64rem;}
  .sw-copylayer{position:fixed;inset:0;z-index:20;pointer-events:none;}
  .sw-copylayer::before{content:"";position:absolute;inset:0;width:min(58vw,780px);background:linear-gradient(90deg,var(--sw-bg) 0%,color-mix(in srgb,var(--sw-bg) 82%,transparent) 34%,color-mix(in srgb,var(--sw-bg) 40%,transparent) 62%,transparent 100%);}
  .sw-copy{position:absolute;left:clamp(18px,5vw,64px);top:50%;transform:translateY(-50%);width:min(42vw,460px);opacity:0;will-change:opacity,transform;}
  .sw-copy__title{font-family:var(--sw-font-display);font-weight:700;color:var(--sw-ink);font-size:clamp(2rem,4.4vw,3.5rem);line-height:1.03;margin:0;letter-spacing:-.01em;text-shadow:0 2px 20px color-mix(in srgb,var(--sw-bg) 70%,transparent);}
  .amx-word-mask{display:inline-block;overflow:hidden;vertical-align:top;margin-right:0.24em;}
  .amx-word-mask:last-child{margin-right:0;}
  .amx-word{display:inline-block;transform-origin:0% 100%;will-change:transform,opacity;}
  .sw-copy__body{margin-top:18px;font-size:clamp(1rem,1.25vw,1.14rem);line-height:1.55;color:color-mix(in srgb,var(--sw-ink) 78%,var(--sw-ink-soft));max-width:40ch;text-shadow:0 1px 12px color-mix(in srgb,var(--sw-bg) 90%,transparent);}
  .sw-copy__tags{list-style:none;display:flex;flex-wrap:wrap;gap:8px;margin:24px 0 0;padding:0;}
  .sw-copy__tags li{font-size:.82rem;font-weight:600;color:color-mix(in srgb,var(--sw-accent) 70%,#000);padding:7px 14px;border-radius:999px;background:color-mix(in srgb,var(--sw-accent) 14%,#fff);border:1px solid color-mix(in srgb,var(--sw-accent) 30%,transparent);}
  .sw-copy__cta{display:flex;flex-wrap:wrap;gap:12px;margin-top:28px;pointer-events:auto;}
  .sw-btn{text-decoration:none;font-weight:600;font-size:.95rem;padding:13px 24px;border-radius:999px;transition:transform .2s;}
  .sw-btn--primary{color:#fff;background:var(--sw-ink);} .sw-btn--primary:hover{transform:translateY(-2px);}
  .sw-btn--ghost{color:var(--sw-ink);border:1.5px solid color-mix(in srgb,var(--sw-ink) 25%,transparent);} .sw-btn--ghost:hover{transform:translateY(-2px);}
  .sw-route{position:fixed;right:clamp(14px,2.4vw,30px);top:50%;z-index:40;transform:translateY(-50%);display:flex;flex-direction:column;gap:22px;padding:18px 10px;}
  .sw-route::before{content:"";position:absolute;left:50%;top:22px;bottom:22px;width:2px;transform:translateX(-50%);background:var(--sw-accent);opacity:.28;}
  .sw-route__dot{position:relative;border:0;background:transparent;cursor:pointer;width:14px;height:14px;display:grid;place-items:center;}
  .sw-route__dot i{width:9px;height:9px;border-radius:50%;background:color-mix(in srgb,var(--sw-accent) 40%,transparent);transition:transform .3s,background .3s,box-shadow .3s;}
  .sw-route__dot:hover i{transform:scale(1.25);background:var(--sw-accent);}
  .sw-route__dot.is-active i{background:var(--sw-accent);transform:scale(1.4);box-shadow:0 0 0 5px color-mix(in srgb,var(--sw-accent) 22%,transparent);}
  .sw-route__label{position:absolute;right:24px;top:50%;transform:translateY(-50%) translateX(6px);white-space:nowrap;font-size:.78rem;font-weight:600;color:var(--sw-ink);background:color-mix(in srgb,#fff 85%,transparent);backdrop-filter:blur(6px);padding:5px 11px;border-radius:999px;opacity:0;pointer-events:none;transition:opacity .25s,transform .25s;border:1px solid color-mix(in srgb,var(--sw-accent) 14%,transparent);}
  .sw-route__dot:hover .sw-route__label,.sw-route__dot.is-active .sw-route__label{opacity:1;transform:translateY(-50%) translateX(0);}
  .sw-hint{position:fixed;left:50%;bottom:26px;z-index:30;transform:translateX(-50%);display:flex;flex-direction:column;align-items:center;gap:10px;font-size:.76rem;letter-spacing:.14em;text-transform:uppercase;color:var(--sw-ink-soft);transition:opacity .3s;}
  .sw-hint i{width:22px;height:34px;border-radius:12px;border:2px solid color-mix(in srgb,var(--sw-ink) 28%,transparent);position:relative;}
  .sw-hint i::after{content:"";position:absolute;left:50%;top:7px;width:4px;height:7px;border-radius:2px;background:var(--sw-accent);transform:translateX(-50%);animation:sw-wheel 1.7s ease-in-out infinite;}
  @keyframes sw-wheel{0%{opacity:0;top:6px}40%{opacity:1}100%{opacity:0;top:17px}}
  .sw-track{position:relative;z-index:1;width:100%;pointer-events:none;}
  .sw-hero{position:absolute;inset:0;z-index:28;display:flex;flex-direction:column;justify-content:space-between;padding:clamp(28px,4.5vw,64px) clamp(24px,6vw,96px);pointer-events:auto;overflow:hidden;will-change:opacity;}
  .sw-hero__backdrop-gradient{position:absolute;inset:0;background:radial-gradient(ellipse at 50% 50%, rgba(10,10,10,0.18) 0%, rgba(10,10,10,0.7) 75%, rgba(10,10,10,0.94) 100%);pointer-events:none;z-index:0;}
  .sw-hero__content{position:relative;z-index:1;display:flex;flex-direction:column;justify-content:space-between;height:100%;width:100%;max-width:1600px;margin:0 auto;will-change:transform;}
  .sw-hero__meta{display:flex;justify-content:space-between;align-items:center;font-family:var(--font-mono,ui-monospace,Menlo,monospace);font-size:clamp(0.65rem,0.8vw,0.76rem);letter-spacing:0.16em;text-transform:uppercase;color:var(--muted,#888);padding-top:clamp(48px,7vh,72px);border-bottom:1px solid rgba(255,255,255,0.08);padding-bottom:14px;}
  .sw-hero__coords{font-weight:600;color:var(--foreground,#ededed);}
  .sw-hero__edition{color:var(--muted,#888);}
  .sw-hero__title-wrap{margin:auto 0;padding:clamp(20px,4vh,40px) 0;overflow:hidden;}
  .sw-hero__title{font-family:var(--font-sans,sans-serif);font-weight:800;font-size:clamp(3.8rem,13.5vw,13.2rem);line-height:0.82;letter-spacing:-0.058em;text-transform:uppercase;color:var(--foreground,#ededed);margin:0;user-select:none;}
  .sw-hero__title-line{display:block;}
  .sw-hero__bottom{display:flex;justify-content:space-between;align-items:flex-end;gap:24px;padding-bottom:clamp(12px,2.5vh,28px);border-top:1px solid rgba(255,255,255,0.08);padding-top:20px;}
  .sw-hero__explore{display:inline-flex;align-items:center;gap:8px;background:transparent;border:none;color:var(--foreground,#ededed);font-family:var(--font-mono,ui-monospace,Menlo,monospace);font-size:clamp(0.72rem,0.9vw,0.82rem);font-weight:700;letter-spacing:0.14em;text-transform:uppercase;cursor:pointer;padding:8px 0;transition:color 0.2s,transform 0.2s;}
  .sw-hero__explore-bracket{color:var(--muted,#888);transition:color 0.2s;}
  .sw-hero__explore-arrow{display:inline-block;transition:transform 0.25s cubic-bezier(0.16,1,0.3,1);}
  .sw-hero__explore:hover{color:#fff;}
  .sw-hero__explore:hover .sw-hero__explore-bracket{color:#fff;}
  .sw-hero__explore:hover .sw-hero__explore-arrow{transform:translateY(4px);}
  .sw-hero__descriptor{display:flex;flex-direction:column;align-items:flex-end;gap:4px;font-family:var(--font-mono,ui-monospace,Menlo,monospace);font-size:clamp(0.65rem,0.78vw,0.72rem);letter-spacing:0.12em;text-transform:uppercase;color:var(--muted,#888);text-align:right;}
  .sw-hero__descriptor-num{color:var(--foreground,#ededed);font-weight:600;}
  @media (max-width:860px){
    .sw-nav{display:none;}
    .sw-figure{display:none !important;}
    .sw-hero{padding:20px 18px;}
    .sw-hero__meta{padding-top:36px;flex-direction:column;align-items:flex-start;gap:6px;border-bottom:none;padding-bottom:0;}
    .sw-hero__title{font-size:clamp(2.9rem,13vw,5.5rem);line-height:0.85;}
    .sw-hero__bottom{flex-direction:column;align-items:flex-start;gap:14px;border-top:none;padding-top:0;padding-bottom:16px;}
    .sw-hero__descriptor{align-items:flex-start;text-align:left;}
    .sw-copylayer::before{width:100%;height:60%;top:auto;bottom:0;background:linear-gradient(0deg,var(--sw-bg) 8%,color-mix(in srgb,var(--sw-bg) 70%,transparent) 46%,transparent 100%);}
    /* Anchor copy to the bottom, clear of the home indicator / collapsing URL bar.
       dvh + env() are progressive: browsers that lack them keep the vh fallback line. */
    .sw-copy{left:clamp(18px,5vw,64px);right:clamp(18px,5vw,64px);top:auto;bottom:clamp(64px,14vh,120px);transform:none;width:auto;max-width:560px;}
    .sw-copy{bottom:calc(clamp(56px,12dvh,110px) + env(safe-area-inset-bottom));}
    .sw-copy__title{font-size:clamp(1.9rem,7.5vw,2.7rem);}
    .sw-copy__body{max-width:none;font-size:clamp(.98rem,3.6vw,1.1rem);} .sw-scene__video,.sw-scene__still{object-position:center 46%;}
    .sw-hint{bottom:calc(20px + env(safe-area-inset-bottom));}
    .sw-route{gap:16px;right:6px;} .sw-route__label{display:none;}
  }
  /* Portrait phones crop a 16:9 clip hard; keep the framing centred so the focal
     subject (which the camera dives toward) stays in view. */
  @media (max-width:860px) and (orientation:portrait){
    .sw-scene__video,.sw-scene__still{object-position:center 44%;}
  }
  /* Touch: give the route dots a finger-sized hit area without growing the visible dot. */
  @media (hover:none) and (pointer:coarse){
    .sw-route{padding:14px 6px;}
    .sw-route__dot{width:28px;height:28px;}
    .sw-btn{padding:15px 26px;}
  }
  @media (prefers-reduced-motion:reduce){ .sw-hint i::after{animation:none;} .sw-pt{display:none;} }
  `;
  // Wrap in a cascade layer so the page's own theme tokens (unlayered
  // :root / .sw-root { --sw-bg / --sw-ink / --sw-accent … }) always win over
  // these defaults, regardless of injection order. Enables clean dark themes.
  const style = document.createElement('style'); style.id = 'sw-css';
  style.textContent = '@layer sw {\n' + css + '\n}';
  document.head.appendChild(style);
}

// Expose for module + global use.
if (typeof module !== 'undefined' && module.exports) module.exports = { mountScrollWorld };
if (typeof window !== 'undefined') window.mountScrollWorld = mountScrollWorld;
