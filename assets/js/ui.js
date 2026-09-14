/*!
 * ui.js — interface behaviour for the ocean portfolio
 * -----------------------------------------------------------------------------
 * Scroll spy + nav indicator, depth HUD, scroll reveals, project track,
 * magnetic buttons, custom cursor, hero crest and the contact form.
 * Everything degrades gracefully: no JS means no hidden content, reduced
 * motion means no animation, no WebGL means the CSS gradient backdrop.
 */
(function () {
  'use strict';

  var doc = document;
  var root = doc.documentElement;
  var reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  var finePointer = window.matchMedia('(hover: hover) and (pointer: fine)').matches;
  var $ = function (sel, ctx) { return (ctx || doc).querySelector(sel); };
  var $$ = function (sel, ctx) { return Array.prototype.slice.call((ctx || doc).querySelectorAll(sel)); };

  /* ==========================================================================
     1. OCEAN BACKGROUND
     ========================================================================== */
  var canvas = $('#ocean');
  var ocean = null;

  if (canvas && window.Ocean) {
    ocean = window.Ocean.mount(canvas, {
      renderScale: window.devicePixelRatio > 1.5 ? 0.8 : 0.9,
      dprCap: 1.5,
      onFrame: function (depth) { updateHUD(depth); }
    });
  } else {
    root.classList.add('no-webgl');
  }

  /* exposed for console tinkering: ocean.setProgress(0.5), ocean.setDebug(1) */
  if (ocean) window.ocean = ocean;

  /* ==========================================================================
     2. SCROLL STATE — depth readout, HUD, nav chrome
     ========================================================================== */
  var hud = $('#hud');
  var hudVal = $('#hudVal');
  var hudZone = $('#hudZone');
  var hudFill = $('#hudFill');
  var nav = $('#nav');
  var lastDepthLabel = '';
  var lastZone = '';

  var ZONES = [
    { max: 0.4, name: 'Surface' },
    { max: 12, name: 'Sunlight zone' },
    { max: 24, name: 'Twilight zone' },
    { max: 34, name: 'Midnight zone' },
    { max: Infinity, name: 'Seabed' }
  ];

  function zoneFor(depth) {
    for (var i = 0; i < ZONES.length; i++) {
      if (depth < ZONES[i].max) return ZONES[i].name;
    }
    return 'Seabed';
  }

  /* Called from the render loop so the readout never lags the water. */
  function updateHUD(depth) {
    if (!hud || !hudVal) return;
    var label = String(Math.max(0, Math.round(depth)));
    if (label !== lastDepthLabel) { hudVal.textContent = label; lastDepthLabel = label; }
    var zone = zoneFor(depth);
    if (zone !== lastZone) { hudZone.textContent = zone; lastZone = zone; }
    hudFill.style.height = (Math.min(1, Math.max(0, depth / 36.5)) * 100).toFixed(1) + '%';
  }

  function scrollProgress() {
    var max = doc.documentElement.scrollHeight - window.innerHeight;
    return max > 0 ? Math.min(1, Math.max(0, window.pageYOffset / max)) : 0;
  }

  function onScroll() {
    var y = window.pageYOffset;

    /* depth variable drives the CSS fallback + any depth-aware styling */
    var p = scrollProgress();
    root.style.setProperty('--depth', p.toFixed(4));

    /* HUD visibility is scroll-driven; its numbers track the camera every frame */
    if (hud) hud.classList.toggle('is-on', y > window.innerHeight * 0.35);

    /* nav chrome: glassy once scrolled. It used to tuck itself out of the way
       when you scrolled down; the brief is for it to stay put throughout. */
    if (nav) nav.classList.toggle('is-scrolled', y > 40);
  }

  /* Safety net. IntersectionObserver callbacks are delivered on the main thread,
     so on a busy or slow device they can lag badly - measured here at several
     seconds while the software renderer held the thread at ~5 fps. Content must
     never stay hidden because of that, so anything already well inside the
     viewport gets shown from the scroll handler too. The 0.7 line sits *past*
     the observer's own trigger point, so this only ever fires for something the
     observer missed; when the observer is healthy it never runs at all. */
  var lastSweep = 0;
  function revealVisible(force) {
    var now = Date.now();
    if (!force && now - lastSweep < 250) return;
    lastSweep = now;
    $$('.reveal:not(.is-in), .reveal-section:not(.is-in)').forEach(function (el) {
      var r = el.getBoundingClientRect();
      if (r.top < window.innerHeight * 0.7 && r.bottom > 0) el.classList.add('is-in');
    });
  }

  window.addEventListener('scroll', function () {
    onScroll();
    revealVisible();
    if (!ocean) updateHUD(window.Ocean ? window.Ocean.depthForProgress(scrollProgress()) : 0);
  }, { passive: true });
  revealVisible(true);
  window.addEventListener('resize', onScroll, { passive: true });

  /* --------------------------------------------------------------------------
     2b. HERO — pin the kicker and the two headline lines to the name's box
     The h1 is inline-block and centred, so its glyph edges sit inside the text
     block rather than flush with it. Measure them and hand the offsets to CSS.
     -------------------------------------------------------------------------- */
  (function heroAlignment() {
    var inner = $('.hero__inner');
    var name = $('.hero__name');
    if (!inner || !name) return;

    function measure() {
      var n = name.getBoundingClientRect();
      var s = inner.getBoundingClientRect();
      if (!n.width || !s.width) return;
      var pad = parseFloat(getComputedStyle(inner).paddingLeft) || 0;
      inner.style.setProperty('--name-l', (n.left - s.left - pad).toFixed(1) + 'px');
      inner.style.setProperty('--name-w', n.width.toFixed(1) + 'px');
    }

    measure();
    /* the name's width depends on the webfont, so measure again once it lands */
    if (doc.fonts && doc.fonts.ready) doc.fonts.ready.then(measure);
    window.addEventListener('load', measure);
    /* Fonts land in stages and each one reflows the centred name, so a single
       load-time measurement can be left holding a stale offset - it was 12 px
       out here. Watching both boxes keeps the two numbers honest whenever
       either one changes size, whatever the cause. */
    if (window.ResizeObserver) {
      var heroRO = new ResizeObserver(function () { measure(); });
      heroRO.observe(inner);
      heroRO.observe(name);
    }
    var t;
    window.addEventListener('resize', function () {
      clearTimeout(t);
      t = setTimeout(measure, 120);
    }, { passive: true });
  }());

  /* ==========================================================================
     3. REVEALS
     ========================================================================== */
  if ('IntersectionObserver' in window) {
    var revealIO = new IntersectionObserver(function (entries) {
      entries.forEach(function (entry) {
        if (entry.isIntersecting) {
          entry.target.classList.add('is-in');
          revealIO.unobserve(entry.target);
        }
      });
    }, { threshold: 0.12, rootMargin: '0px 0px -8% 0px' });
    $$('.reveal, .reveal-section').forEach(function (el) { revealIO.observe(el); });

    var certIO = new IntersectionObserver(function (entries) {
      entries.forEach(function (entry) {
        if (entry.isIntersecting) entry.target.classList.add('is-in');
      });
    }, { threshold: 0.6 });
    $$('.cert').forEach(function (el) { certIO.observe(el); });

    var flowIO = new IntersectionObserver(function (entries) {
      entries.forEach(function (entry) {
        if (!entry.isIntersecting) return;
        $$('.flow__step', entry.target).forEach(function (step, i) {
          setTimeout(function () { step.classList.add('is-played'); }, 120 + i * 120);
        });
        flowIO.unobserve(entry.target);
      });
    }, { threshold: 0.45 });
    $$('.card').forEach(function (el) { flowIO.observe(el); });
  } else {
    $$('.reveal').forEach(function (el) { el.classList.add('is-in'); });
    $$('.flow__step').forEach(function (el) { el.classList.add('is-played'); });
    $$('.cert').forEach(function (el) { el.classList.add('is-in'); });
  }

  /* --------------------------------------------------------------------------
     3b. CREDENTIALS — fold past six rows
     The list is a plain stacked list, so it grows rather than scrolling: every
     certificate added makes the page longer. Past six rows it folds behind a
     toggle instead. The button ships hidden and stays hidden while there is
     nothing to hide, so the current six render exactly as they always have.
     -------------------------------------------------------------------------- */
  (function certsFold() {
    var list = $('#certs');
    var btn = $('#certsMore');
    if (!list || !btn) return;

    var LIMIT = 6;
    var total = list.children.length;
    if (total <= LIMIT) return;

    var txt = $('.certs__more-txt', btn);
    var collapsed = true;

    function apply() {
      list.classList.toggle('is-collapsed', collapsed);
      btn.hidden = false;
      btn.setAttribute('aria-expanded', collapsed ? 'false' : 'true');
      if (txt) txt.textContent = collapsed ? 'View all ' + total : 'Show fewer';
    }

    btn.addEventListener('click', function () {
      collapsed = !collapsed;
      apply();
      /* Rows hidden by display:none never intersect, so the observer that lights
         their dots never ran. Light them on expand rather than leaving them dim. */
      if (!collapsed) $$('.cert', list).forEach(function (el) { el.classList.add('is-in'); });
    });

    apply();
  })();

  /* ==========================================================================
     4. NAV — scroll spy, indicator, mobile menu
     ========================================================================== */
  var navLinks = $$('.nav__links a[data-section]');
  var indicator = $('#navIndicator');
  var navToggle = $('#navToggle');
  var mobileMenu = $('#mobileMenu');
  var sections = navLinks.map(function (a) { return doc.getElementById(a.dataset.section); });
  /* Contact lost its nav link to the Let's talk button, but it is still a
     section - without observing it, arriving there fired no entry and left
     Credentials lit for the rest of the page. The marquee section is left
     unobserved on purpose: it is a 169 px band between Work and About, and
     keeping Work lit across it reads better than blanking the bar. */
  var contactSection = doc.getElementById('contact');
  if (contactSection && sections.indexOf(contactSection) < 0) sections.push(contactSection);

  function isMenuOpen() { return mobileMenu && mobileMenu.classList.contains('is-open'); }

  function moveIndicator(link) {
    if (!indicator || !link) return;
    indicator.style.left = link.offsetLeft + 'px';
    indicator.style.width = link.offsetWidth + 'px';
    indicator.classList.add('is-on');
  }

  /* Clicking a link has to beat the spy to the indicator. The page smooth
     scrolls, so a jump from Home to About travels straight through Work, and
     the spy dutifully lit Work on the way past - the line took a detour
     instead of going to the link you pressed. The click sets the indicator and
     holds it until the scrolling comes to rest. */
  var spyLock = 0;
  navLinks.forEach(function (link) {
    link.addEventListener('click', function () {
      navLinks.forEach(function (l) { l.classList.toggle('is-active', l === link); });
      moveIndicator(link);
      spyLock = 1;
      var started = Date.now(), last = -1, still = 0;
      (function settle() {
        var y = window.pageYOffset;
        if (y === last) still++; else { still = 0; last = y; }
        /* Three quiet samples, but never before the scroll has had a chance to
           begin - otherwise a slow start releases the lock before it moves. */
        if ((still >= 3 && Date.now() - started > 400) || Date.now() - started > 4000) { spyLock = 0; return; }
        setTimeout(settle, 80);
      })();
    });
  });

  if ('IntersectionObserver' in window && sections.length) {
    var spy = new IntersectionObserver(function (entries) {
      entries.forEach(function (entry) {
        if (spyLock || !entry.isIntersecting) return;
        var id = entry.target.id;
        var matched = false;
        navLinks.forEach(function (link) {
          var on = link.dataset.section === id;
          link.classList.toggle('is-active', on);
          if (on) { moveIndicator(link); matched = true; }
        });
        /* Contact is no longer in the bar - the Let's talk button is - so the
           spy has no link to light there. Drop the underline instead of
           leaving it parked under Credentials. */
        if (!matched && indicator) indicator.classList.remove('is-on');
      });
    }, { rootMargin: '-45% 0px -50% 0px', threshold: 0 });
    sections.forEach(function (s) { if (s) spy.observe(s); });
  }

  window.addEventListener('load', function () {
    var first = navLinks[0];
    if (first) { first.classList.add('is-active'); moveIndicator(first); }
    onScroll();
  });
  window.addEventListener('resize', function () {
    var active = navLinks.filter(function (l) { return l.classList.contains('is-active'); })[0];
    moveIndicator(active || navLinks[0]);
  }, { passive: true });

  function closeMenu() {
    if (!mobileMenu) return;
    mobileMenu.classList.remove('is-open');
    navToggle.setAttribute('aria-expanded', 'false');
    navToggle.setAttribute('aria-label', 'Open menu');
    setTimeout(function () { if (!isMenuOpen()) mobileMenu.hidden = true; }, 280);
  }

  if (navToggle) {
    navToggle.addEventListener('click', function () {
      var open = !isMenuOpen();
      if (open) {
        mobileMenu.hidden = false;
        /* force a frame so the transition runs */
        requestAnimationFrame(function () { mobileMenu.classList.add('is-open'); });
        navToggle.setAttribute('aria-expanded', 'true');
        navToggle.setAttribute('aria-label', 'Close menu');
      } else {
        closeMenu();
      }
    });

    $$('a', mobileMenu).forEach(function (a) {
      a.addEventListener('click', closeMenu);
    });

    doc.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && isMenuOpen()) { closeMenu(); navToggle.focus(); }
    });

    doc.addEventListener('click', function (e) {
      if (isMenuOpen() && !mobileMenu.contains(e.target) && !navToggle.contains(e.target)) closeMenu();
    });
  }

  /* ==========================================================================
     5. PROJECT TRACK — dots, drag, wheel, keyboard
     ========================================================================== */
  var track = $('#projectTrack');
  var dotsWrap = $('#trackDots');

  if (track && dotsWrap) {
    var cards = $$('.card', track);
    cards.forEach(function (_, i) {
      var dot = doc.createElement('span');
      if (i === 0) dot.className = 'is-active';
      dotsWrap.appendChild(dot);
    });
    var dots = $$('span', dotsWrap);

    function syncDots() {
      var width = track.scrollWidth / Math.max(1, cards.length);
      var idx = Math.round(track.scrollLeft / width);
      idx = Math.min(cards.length - 1, Math.max(0, idx));
      dots.forEach(function (d, i) { d.classList.toggle('is-active', i === idx); });
    }
    track.addEventListener('scroll', syncDots, { passive: true });

    /* vertical wheel scrolls the rail horizontally while it's in view */
    if (finePointer && !reduceMotion) {
      track.addEventListener('wheel', function (e) {
        if (Math.abs(e.deltaY) <= Math.abs(e.deltaX)) return;
        var atStart = track.scrollLeft <= 0 && e.deltaY < 0;
        var atEnd = track.scrollLeft >= track.scrollWidth - track.clientWidth - 1 && e.deltaY > 0;
        if (atStart || atEnd) return;           // let the page take over at the ends
        e.preventDefault();
        track.scrollLeft += e.deltaY;
      }, { passive: false });
    }

    /* drag to scroll */
    var dragging = false, startX = 0, startScroll = 0, moved = 0;
    track.addEventListener('pointerdown', function (e) {
      if (e.pointerType === 'touch') return;    // native touch scrolling is better
      dragging = true; moved = 0;
      startX = e.clientX; startScroll = track.scrollLeft;
      track.style.scrollSnapType = 'none';
      track.style.cursor = 'grabbing';
    });
    track.addEventListener('pointermove', function (e) {
      if (!dragging) return;
      var dx = e.clientX - startX;
      moved = Math.max(moved, Math.abs(dx));
      track.scrollLeft = startScroll - dx;
    });
    ['pointerup', 'pointercancel', 'pointerleave'].forEach(function (evt) {
      track.addEventListener(evt, function () {
        if (!dragging) return;
        dragging = false;
        track.style.scrollSnapType = '';
        track.style.cursor = '';
      });
    });
    track.addEventListener('click', function (e) {
      if (moved > 6) { e.preventDefault(); e.stopPropagation(); }
    }, true);

    /* keyboard */
    track.addEventListener('keydown', function (e) {
      var step = (cards[0] ? cards[0].offsetWidth + 22 : 320);
      if (e.key === 'ArrowRight') { track.scrollLeft += step; e.preventDefault(); }
      if (e.key === 'ArrowLeft') { track.scrollLeft -= step; e.preventDefault(); }
    });
  }

  /* ==========================================================================
     6. MAGNETIC BUTTONS + CARD TILT (fine pointers only)
     ========================================================================== */
  var magnets = $$('.magnetic');
  var tiltCards = $$('.card');

  if (finePointer && !reduceMotion) {
    var pointer = { x: 0, y: 0 };
    window.addEventListener('pointermove', function (e) { pointer.x = e.clientX; pointer.y = e.clientY; }, { passive: true });

    window.addEventListener('scroll', function () {
      if (!magnets.length) return;
      for (var i = 0; i < magnets.length; i++) {
        var el = magnets[i];
        var r = el.getBoundingClientRect();
        var relX = pointer.x - (r.left + r.width / 2);
        var relY = pointer.y - (r.top + r.height / 2);
        var radius = Math.max(r.width, r.height) * 1.1 + 18;
        var dist = Math.sqrt(relX * relX + relY * relY);
        if (dist < radius) {
          var pull = 1 - dist / radius;
          var dx = Math.max(-7, Math.min(7, relX * 0.16 * pull));
          var dy = Math.max(-7, Math.min(7, relY * 0.16 * pull));
          el.style.transform = 'translate3d(' + dx + 'px,' + dy + 'px,0)';
        } else if (el.style.transform) {
          el.style.transform = '';
        }
      }
    }, { passive: true });

    tiltCards.forEach(function (card) {
      card.setAttribute('data-cursor', 'card');
      card.addEventListener('pointermove', function (e) {
        var r = card.getBoundingClientRect();
        var px = (e.clientX - r.left) / r.width - 0.5;
        var py = (e.clientY - r.top) / r.height - 0.5;
        card.style.transform =
          'perspective(900px) rotateX(' + (py * -5).toFixed(2) + 'deg) rotateY(' + (px * 5).toFixed(2) + 'deg) translateY(-4px)';
      });
      card.addEventListener('pointerleave', function () {
        card.style.transform = '';
      });
    });
  }

  /* ==========================================================================
     7. CUSTOM CURSOR
     ========================================================================== */
  var cursorEl = $('#cursor');
  if (cursorEl && finePointer && !reduceMotion) {
    doc.body.classList.add('has-cursor');
    var cx = 0, cy = 0, tx = 0, ty = 0;
    window.addEventListener('pointermove', function (e) { tx = e.clientX; ty = e.clientY; }, { passive: true });

    (function loop() {
      cx += (tx - cx) * 0.22;
      cy += (ty - cy) * 0.22;
      cursorEl.style.transform = 'translate3d(' + cx.toFixed(1) + 'px,' + cy.toFixed(1) + 'px,0) translate(-50%,-50%)';
      requestAnimationFrame(loop);
    })();

    doc.addEventListener('pointerover', function (e) {
      var t = e.target;
      if (!(t instanceof Element)) return;
      if (t.closest('[data-cursor="card"]')) cursorEl.classList.add('is-card');
      else if (t.closest('a,button,input,textarea,select,summary')) cursorEl.classList.add('is-link');
    });
    doc.addEventListener('pointerout', function (e) {
      var t = e.target;
      if (!(t instanceof Element)) return;
      if (t.closest('[data-cursor="card"]')) cursorEl.classList.remove('is-card');
      else if (t.closest('a,button,input,textarea,select,summary')) cursorEl.classList.remove('is-link');
    });
  }

  /* ==========================================================================
     8. HERO CREST
     ========================================================================== */
  var heroName = $('#heroName');
  var heroCrest = $('#heroCrest');
  if (heroName && heroCrest && finePointer && !reduceMotion) {
    heroName.addEventListener('pointermove', function (e) {
      var r = heroName.getBoundingClientRect();
      heroCrest.style.left = (e.clientX - r.left) + 'px';
      heroCrest.style.top = (e.clientY - r.top) + 'px';
    });
    heroName.addEventListener('pointerenter', function () { heroCrest.classList.add('is-on'); });
    heroName.addEventListener('pointerleave', function () { heroCrest.classList.remove('is-on'); });
  }

  /* ==========================================================================
     9. CONTACT FORM
     Posts to data-endpoint when one is configured, otherwise hands off to the
     visitor's mail client — no backend needed for a static deploy.
     ========================================================================== */
  var form = $('#contactForm');
  if (form) {
    var note = $('#formNote');
    var submit = $('#formSubmit');

    function setNote(message, isError) {
      if (!note) return;
      note.textContent = message;
      note.classList.toggle('is-error', !!isError);
    }

    function invalid(field, on) {
      var wrap = field.closest('.field');
      if (wrap) wrap.classList.toggle('is-invalid', on);
      return on;
    }

    form.addEventListener('submit', function (e) {
      e.preventDefault();

      var name = form.elements.name;
      var email = form.elements.email;
      var message = form.elements.message;
      var type = form.elements.projectType;

      var bad = false;
      bad = invalid(name, !name.value.trim()) || bad;
      bad = invalid(email, !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email.value.trim())) || bad;
      bad = invalid(message, message.value.trim().length < 4) || bad;

      if (bad) { setNote('Please fill in your name, a valid email and a short message.', true); return; }
      setNote('');

      var subject = 'New enquiry — ' + (type ? type.value : 'Website');
      var body = 'Name: ' + name.value.trim() + '\n' +
                 'Email: ' + email.value.trim() + '\n' +
                 'Project: ' + (type ? type.value : '—') + '\n\n' +
                 message.value.trim();

      var endpoint = form.getAttribute('data-endpoint');

      if (endpoint) {
        var original = submit.innerHTML;
        submit.disabled = true;
        submit.textContent = 'Sending…';
        fetch(endpoint, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
          body: JSON.stringify({
            name: name.value.trim(),
            email: email.value.trim(),
            projectType: type ? type.value : '',
            message: message.value.trim(),
            subject: subject
          })
        })
          .then(function (res) {
            if (!res.ok) throw new Error(res.status);
            form.innerHTML = '<div class="form__done"><p class="form__done-title">Message received.</p>' +
              '<p>I\'ll be back to you within one business day — usually much sooner.</p></div>';
          })
          .catch(function () {
            submit.disabled = false;
            submit.innerHTML = original;
            setNote('Something went wrong. Email me directly at hello.jjoyce@gmail.com.', true);
          });
        return;
      }

      /* mail hand-off */
      var mailto = 'mailto:hello.jjoyce@gmail.com?subject=' + encodeURIComponent(subject) +
                   '&body=' + encodeURIComponent(body);
      setNote('Opening your mail client…');
      window.location.href = mailto;
      setTimeout(function () {
        setNote('If nothing opened, email me at hello.jjoyce@gmail.com.');
      }, 1600);
    });

    /* clear the error state as soon as the visitor starts fixing things */
    $$('input, textarea', form).forEach(function (field) {
      field.addEventListener('input', function () {
        var wrap = field.closest('.field');
        if (wrap) wrap.classList.remove('is-invalid');
        if (note && note.classList.contains('is-error')) setNote('');
      });
    });
  }

  /* ==========================================================================
     10. MISC
     ========================================================================== */
  var year = $('#year');
  if (year) year.textContent = String(new Date().getFullYear());

  /* keep the ocean surface crisp across orientation changes */
  window.addEventListener('orientationchange', function () {
    setTimeout(onScroll, 300);
  });

  onScroll();
})();
