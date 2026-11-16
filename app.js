/* =========================================================
   우리집 가족 대시보드 — app.js
   - 상단 탭(포켓몬 / 대시보드 / 아이 / 퀘스트 / 일정 / 위시·우체통)
   - 아이별 포켓몬 알 부화·진화·개인 보관함(포켓몬 마을), 스티커 적립
   - 퀘스트 / XP / 레벨, 오늘 일정 & 준비물, 가족 캘린더, D-Day
   - 위시리스트, 가족 우체통
   - localStorage 즉시 저장 + Firebase RTDB 실시간 동기화(선택)
   ========================================================= */
'use strict';

(function () {
  var STORAGE_KEY = 'family-dashboard.state.v1';
  var SYNC_KEY = 'family-dashboard.sync.v1';
  var LEVEL_XP = 100;
  var POLL_MS = 5000;
  var PUSH_DEBOUNCE = 600;
  var LOG_LIMIT = 60;
  var VIEWS = ['pokemon', 'dashboard', 'quest', 'schedule', 'family'];

  var STATE_ICON = {
    local: '💾 이 기기 저장',
    syncing: '🔄 동기화 중…',
    synced: '✅ 동기화됨',
    error: '⚠️ 동기화 오류'
  };

  var TYPE_LABEL = {
    fire: '불꽃', water: '물', electric: '전기', grass: '풀',
    normal: '노말', fairy: '페어리', fighting: '격투', psychic: '에스퍼', dark: '악'
  };

  var WEEKDAYS = ['일요일', '월요일', '화요일', '수요일', '목요일', '금요일', '토요일'];
  var WEEKDAYS_SHORT = ['일', '월', '화', '수', '목', '금', '토'];

  /* 마을에 포켓몬을 놓는 자리 (겹치지 않게 3줄로 배치) */
  var SLOTS = [
    { x: 8, y: 30, k: 0.84 }, { x: 27, y: 25, k: 0.78 }, { x: 47, y: 23, k: 0.8 }, { x: 67, y: 26, k: 0.78 }, { x: 86, y: 31, k: 0.84 },
    { x: 16, y: 51, k: 0.96 }, { x: 37, y: 48, k: 0.92 }, { x: 58, y: 49, k: 0.96 }, { x: 79, y: 47, k: 0.92 },
    { x: 9, y: 72, k: 1.08 }, { x: 28, y: 76, k: 1.02 }, { x: 48, y: 71, k: 1.1 }, { x: 69, y: 76, k: 1.02 }, { x: 88, y: 72, k: 1.06 }
  ];

  var data = null;
  var state = null;
  var sync = { url: '', enabled: false };
  var view = 'pokemon';
  var currentKid = null;
  var calMonth = null;          // { y, m } (m: 0-11)
  var selectedDate = null;      // 'YYYY-MM-DD'
  var pollTimer = null;
  var pushTimer = null;
  var lastPayload = '';
  var clockTimer = null;
  var eventIndex = {};

  var CAL_TARGETS = [
    { grid: '#cal-grid', month: '#cal-month', detail: '#day-detail', prev: '#cal-prev', next: '#cal-next' },
    { grid: '#cal-grid-2', month: '#cal-month-2', detail: '#day-detail-2', prev: '#cal-prev-2', next: '#cal-next-2' }
  ];
  var TODAY_LISTS = ['#today-list', '#today-list-schedule'];
  var DDAY_LISTS = ['#dday-list', '#dday-list-schedule'];
  var NOTE_LISTS = ['#notes', '#notes-2'];
  var NOTE_FORMS = [
    { form: '#note-form', from: '#note-from', text: '#note-text' },
    { form: '#note-form-2', from: '#note-from-2', text: '#note-text-2' }
  ];
  var NOTE_EMPTY = ['#note-empty', '#note-empty-2'];
  var QUICK_BOXES = ['#quick-notes', '#quick-notes-2'];

  /* ---------------- 작은 도우미 ---------------- */
  function $(sel, root) { return (root || document).querySelector(sel); }
  function $$(sel, root) { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); }
  function pad(n) { return (n < 10 ? '0' : '') + n; }
  function uid() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 7); }

  function esc(value) {
    return String(value == null ? '' : value).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function setText(sel, text) {
    var el = $(sel);
    if (el) el.textContent = text;
  }

  function dateKey(d) {
    var t = d || new Date();
    return t.getFullYear() + '-' + pad(t.getMonth() + 1) + '-' + pad(t.getDate());
  }

  function parseKey(key) {
    var parts = String(key).split('-');
    return new Date(Number(parts[0]), Number(parts[1]) - 1, Number(parts[2]));
  }

  function addDays(d, n) {
    var t = new Date(d.getTime());
    t.setDate(t.getDate() + n);
    return t;
  }

  function dayDiff(a, b) {
    var A = new Date(a.getFullYear(), a.getMonth(), a.getDate()).getTime();
    var B = new Date(b.getFullYear(), b.getMonth(), b.getDate()).getTime();
    return Math.round((A - B) / 86400000);
  }

  function relTime(iso) {
    var d = new Date(iso);
    if (isNaN(d.getTime())) return '';
    var now = new Date();
    var sameDay = d.toDateString() === now.toDateString();
    var hm = pad(d.getHours()) + ':' + pad(d.getMinutes());
    if (sameDay) return '오늘 ' + hm;
    return (d.getMonth() + 1) + '/' + d.getDate() + ' ' + hm;
  }

  function hasJong(word) {
    var s = String(word || '');
    if (!s) return false;
    var c = s.charCodeAt(s.length - 1);
    if (c < 0xAC00 || c > 0xD7A3) return false;
    return ((c - 0xAC00) % 28) !== 0;
  }
  function ro(word) { return word + (hasJong(word) ? '으로' : '로'); }
  function iGa(word) { return word + (hasJong(word) ? '이' : '가'); }

  function toast(message, kind) {
    var stack = $('#toasts');
    if (!stack) return;
    var el = document.createElement('div');
    el.className = 'toast' + (kind ? ' toast--' + kind : '');
    el.textContent = message;
    stack.appendChild(el);
    window.setTimeout(function () {
      el.classList.add('is-out');
      window.setTimeout(function () { if (el.parentNode) el.parentNode.removeChild(el); }, 320);
    }, 2600);
  }

  function typeLabel(type) {
    return TYPE_LABEL[type] || '노말';
  }

  /* ---------------- 저장 ---------------- */
  function saveLocal() {
    try {
      state._ts = Date.now();
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    } catch (err) {
      /* 저장 공간이 막힌 브라우저(사생활 모드 등)에서는 조용히 넘어갑니다. */
    }
    var foot = $('#foot-updated');
    if (foot) foot.textContent = '이 화면 마지막 저장 · ' + relTime(new Date(state._ts).toISOString());
  }

  function touch() {
    saveLocal();
    schedulePush();
  }

  function loadSync() {
    try {
      var raw = window.localStorage.getItem(SYNC_KEY);
      if (raw) {
        var parsed = JSON.parse(raw);
        if (parsed && typeof parsed.url === 'string') {
          return { url: parsed.url, enabled: !!parsed.enabled && !!parsed.url };
        }
      }
    } catch (err) { /* 무시 */ }
    return { url: '', enabled: false };
  }

  function persistSync() {
    try { window.localStorage.setItem(SYNC_KEY, JSON.stringify(sync)); } catch (err) { /* 무시 */ }
  }

  /* ---------------- 포켓몬 데이터 도우미 ---------------- */
  function pokeData() { return (data && data.pokemon) || null; }

  function familyOf(familyId) {
    var p = pokeData();
    if (!p || !Array.isArray(p.families)) return null;
    for (var i = 0; i < p.families.length; i += 1) {
      if (p.families[i].id === familyId) return p.families[i];
    }
    return null;
  }

  function dexInfo(dex) {
    var p = pokeData();
    if (!p || !p.dex) return null;
    return p.dex[String(dex)] || null;
  }

  function stageCost(fam, stage) {
    var p = pokeData();
    var c = (p && p.costs) || {};
    if (stage <= 0) return Number(fam && fam.hatchCost) || Number(c.hatch) || 3;
    if (stage === 1) return Number(c.evolve1) || 4;
    return Number(c.evolve2) || 6;
  }

  function spriteStyle(dex, size) {
    var p = pokeData();
    if (!p || !p.dexIndex) return '';
    var idx = p.dexIndex[String(dex)];
    if (idx === undefined || idx === null) return '';
    var cols = (p.sprite && p.sprite.cols) || 8;
    var rows = (p.sprite && p.sprite.rows) || 4;
    var col = idx % cols;
    var row = Math.floor(idx / cols);
    return '--s:' + size + 'px;--c:' + col + ';--r:' + row + ';--cols:' + cols + ';--rows:' + rows;
  }

  function spriteHtml(dex, size, extraClass) {
    var info = dexInfo(dex);
    return '<span class="sprite ' + (extraClass || '') + '" style="' + spriteStyle(dex, size) + '"' +
      ' role="img" aria-label="' + esc(info ? info.name : '포켓몬') + '"></span>';
  }

  function pickEggFamily(kidId) {
    var p = pokeData();
    if (!p || !Array.isArray(p.families) || !p.families.length) return '';
    var kid = state.kids[kidId];
    var box = (kid && Array.isArray(kid.box)) ? kid.box : [];
    if (!box.length) {
      for (var i = 0; i < p.families.length; i += 1) {
        if (p.families[i].starter === kidId) return p.families[i].id;
      }
    }
    var lastFam = box.length ? box[box.length - 1].family : '';
    var pool = p.families.filter(function (f) { return f.id !== lastFam; });
    if (!pool.length) pool = p.families;
    return pool[Math.floor(Math.random() * pool.length)].id;
  }

  function starterFamily(kidId) {
    var p = pokeData();
    if (!p || !Array.isArray(p.families)) return '';
    for (var i = 0; i < p.families.length; i += 1) {
      if (p.families[i].starter === kidId) return p.families[i].id;
    }
    return p.families[0] ? p.families[0].id : '';
  }

  function kidDef(kidId) {
    var kids = (data && data.kids) || [];
    for (var i = 0; i < kids.length; i += 1) {
      if (kids[i].id === kidId) return kids[i];
    }
    return null;
  }

  /* ---------------- 상태 정규화 ---------------- */
  function normalizeState(raw) {
    var s = (raw && typeof raw === 'object') ? raw : {};
    var out = {
      version: 2,
      _ts: Number(s._ts) || 0,
      kids: {},
      wishlist: Array.isArray(s.wishlist) ? s.wishlist : [],
      notes: Array.isArray(s.notes) ? s.notes : []
    };

    var rawKids = (s.kids && typeof s.kids === 'object') ? s.kids : {};
    var definitions = (data && Array.isArray(data.kids)) ? data.kids : [];

    definitions.forEach(function (def) {
      var cur = rawKids[def.id] || {};
      var curQuests = Array.isArray(cur.quests) ? cur.quests : [];
      var byId = {};
      curQuests.forEach(function (q) { if (q && q.id) byId[q.id] = q; });

      var quests = (def.quests || []).map(function (q) {
        var found = byId[q.id];
        return {
          id: q.id,
          text: (found && found.text) ? String(found.text) : q.text,
          xp: (found && Number(found.xp)) ? Number(found.xp) : Number(q.xp) || 10,
          done: !!(found && found.done),
          custom: false
        };
      });

      curQuests.forEach(function (q) {
        if (!q || !q.id) return;
        var exists = quests.some(function (d) { return d.id === q.id; });
        if (exists) return;
        quests.push({
          id: String(q.id),
          text: q.text ? String(q.text) : '새 퀘스트',
          xp: Number(q.xp) || 10,
          done: !!q.done,
          custom: true
        });
      });

      /* ---- 포켓몬: 알/진화 단계 · 스티커 · 보관함 ---- */
      var activeRaw = (cur.active && typeof cur.active === 'object') ? cur.active : {};
      var famId = activeRaw.family ? String(activeRaw.family) : '';
      var fam = familyOf(famId);
      if (!fam) { famId = starterFamily(def.id); fam = familyOf(famId); }
      var maxStage = fam ? fam.stages.length : 0;
      var stage = Number(activeRaw.stage) || 0;
      if (stage < 0) stage = 0;
      if (stage > maxStage) stage = maxStage;

      var box = Array.isArray(cur.box) ? cur.box.filter(function (b) {
        return b && b.id && b.dex && dexInfo(b.dex);
      }).map(function (b) {
        return {
          id: String(b.id),
          dex: Number(b.dex),
          family: b.family ? String(b.family) : '',
          at: b.at ? String(b.at) : new Date().toISOString()
        };
      }) : [];

      var log = Array.isArray(cur.stickerLog) ? cur.stickerLog.filter(function (e) {
        return e && e.at;
      }).map(function (e) {
        return {
          id: e.id ? String(e.id) : uid(),
          at: String(e.at),
          amount: Math.max(1, Math.floor(Number(e.amount) || 1)),
          reason: e.reason ? String(e.reason) : '스티커',
          src: e.src ? String(e.src) : 'parent',
          questId: e.questId ? String(e.questId) : ''
        };
      }) : [];
      if (log.length > LOG_LIMIT) log = log.slice(-LOG_LIMIT);

      var total = Math.max(0, Math.floor(Number(cur.stickerTotal) || 0));
      var logSum = log.reduce(function (sum, e) { return sum + e.amount; }, 0);
      if (total < logSum) total = logSum;

      out.kids[def.id] = {
        xp: Math.max(0, Number(cur.xp) || 0),
        resetDate: cur.resetDate ? String(cur.resetDate) : dateKey(),
        quests: quests,
        stickers: Math.max(0, Math.floor(Number(cur.stickers) || 0)),
        stickerTotal: total,
        stickerLog: log,
        active: {
          family: famId,
          stage: stage,
          eggNo: Math.max(1, Math.floor(Number(activeRaw.eggNo) || 1)),
          since: activeRaw.since ? String(activeRaw.since) : new Date().toISOString()
        },
        box: box
      };
    });

    out.wishlist = out.wishlist.filter(function (w) { return w && w.id; }).map(function (w) {
      return {
        id: String(w.id),
        who: w.who ? String(w.who) : '',
        item: w.item ? String(w.item) : '',
        memo: w.memo ? String(w.memo) : '',
        price: Number(w.price) || 0,
        done: !!w.done,
        createdAt: w.createdAt ? String(w.createdAt) : new Date().toISOString()
      };
    });

    out.notes = out.notes.filter(function (n) { return n && n.id; }).map(function (n) {
      return {
        id: String(n.id),
        from: n.from ? String(n.from) : '',
        text: n.text ? String(n.text) : '',
        createdAt: n.createdAt ? String(n.createdAt) : new Date().toISOString()
      };
    });

    return out;
  }

  /* ---------------- 하루 초기화 ---------------- */
  function ensureDailyReset() {
    var today = dateKey();
    var changed = false;
    (data && data.kids ? data.kids : []).forEach(function (def) {
      var kid = state.kids[def.id];
      if (!kid) return;
      if (kid.resetDate !== today) {
        kid.quests.forEach(function (q) { q.done = false; });
        kid.resetDate = today;
        changed = true;
      }
    });
    return changed;
  }

  /* ---------------- XP / 레벨 ---------------- */
  function levelOf(xp) { return Math.floor(xp / LEVEL_XP) + 1; }

  /* =========================================================
     상단 탭
     ========================================================= */
  function renderTabs() {
    var wrap = $('#tabs-kids');
    if (!wrap || !data || !Array.isArray(data.kids)) return;
    wrap.innerHTML = data.kids.map(function (def) {
      return '<button type="button" class="tab tab--kid" data-kid="' + esc(def.id) + '" aria-pressed="false">' +
        '<span aria-hidden="true">' + esc(def.emoji || '⭐') + '</span> ' + esc(def.name) + '</button>';
    }).join('');
  }

  function syncTabState() {
    $$('.tab').forEach(function (btn) {
      var v = btn.getAttribute('data-view');
      var k = btn.getAttribute('data-kid');
      var on = false;
      if (k) on = (view === 'pokemon' && k === currentKid);
      else if (v) on = (view === v);
      btn.setAttribute('aria-pressed', on ? 'true' : 'false');
    });
  }

  function writeHash() {
    var h = (view === 'pokemon' && currentKid) ? '#pokemon/' + currentKid : '#' + view;
    if (window.location.hash === h) return;
    try { window.history.replaceState(null, '', h); } catch (err) { /* 무시 */ }
  }

  function setView(next, kidId, opts) {
    if (VIEWS.indexOf(next) < 0) next = 'pokemon';
    if (kidId && state && state.kids[kidId]) currentKid = kidId;
    view = next;

    $$('.view').forEach(function (sec) {
      sec.hidden = sec.getAttribute('data-view') !== view;
    });
    syncTabState();

    if (view === 'pokemon') renderPokemon();
    if (view === 'quest') renderKids();
    if (view === 'dashboard' || view === 'schedule') {
      renderToday();
      renderDday();
      renderCalendar();
    }
    if (view === 'dashboard' || view === 'family') {
      renderWishlist();
      renderNotes();
    }

    if (!opts || !opts.silent) {
      try { window.scrollTo(0, 0); } catch (err) { /* 무시 */ }
    }
    writeHash();
  }

  function readHash() {
    var h = String(window.location.hash || '').replace(/^#/, '');
    if (!h) return false;
    var parts = h.split('/');
    if (VIEWS.indexOf(parts[0]) < 0) return false;
    setView(parts[0], parts[1], { silent: true });
    return true;
  }

  /* =========================================================
     렌더링 — 공통
     ========================================================= */
  function renderClock() {
    var now = new Date();
    var hour = now.getHours();
    var meridiem = hour < 12 ? '오전' : '오후';
    var hour12 = hour % 12 || 12;
    var clockText = '지금은 ' + meridiem + ' ' + hour12 + ':' + pad(now.getMinutes());

    setText('#clock', clockText);
    setText('#today-date', (now.getMonth() + 1) + '월 ' + now.getDate() + '일 (' + WEEKDAYS_SHORT[now.getDay()] + ')');

    var subText = (now.getMonth() + 1) + '월 ' + now.getDate() + '일 ' + WEEKDAYS[now.getDay()] + ' 기준';
    ['#today-date-sub', '#today-date-sub2', '#today-date-sub3'].forEach(function (sel) {
      setText(sel, subText);
    });
  }

  function renderWeather() {
    if (!data || !data.weather) return;
    var w = data.weather;

    setText('#weather-emoji', w.emoji || '🌤️');
    setText('#weather-place', w.place || '');
    setText('#weather-temp', w.tempMin + '~' + w.tempMax + '°C');
    setText('#weather-summary', w.summary || '');
    setText('#weather-outfit', w.outfit || '');

    var badge = $('#air-badge');
    if (badge && w.air) {
      badge.hidden = false;
      badge.dataset.level = w.air.level || 'moderate';
      badge.textContent = w.air.label + ' ' + w.air.pollutant + ' ' + w.air.value + ' ' + (w.air.advice || '');
    }
  }

  /* =========================================================
     렌더링 — 퀘스트 카드
     ========================================================= */
  function kidCardHtml(def) {
    var kid = state.kids[def.id];
    if (!kid) return '';

    var xp = kid.xp;
    var level = levelOf(xp);
    var progress = xp % LEVEL_XP;
    var remaining = LEVEL_XP - progress;
    var doneCount = kid.quests.filter(function (q) { return q.done; }).length;
    var allDone = kid.quests.length > 0 && doneCount === kid.quests.length;

    var quests = kid.quests.map(function (q) {
      var inputId = 'q-' + def.id + '-' + q.id;
      return '' +
        '<label class="quest' + (q.done ? ' is-done' : '') + '" data-quest="' + esc(q.id) + '">' +
          '<input type="checkbox" id="' + esc(inputId) + '" data-action="toggle"' + (q.done ? ' checked' : '') + '>' +
          '<span class="quest__text">' + esc(q.text) + '</span>' +
          '<span class="quest__xp">+' + q.xp + ' XP · ⭐1</span>' +
          (q.custom ? '<button type="button" class="quest__del" data-action="del-quest" aria-label="' + esc(q.text) + ' 퀘스트 삭제">✕</button>' : '') +
        '</label>';
    }).join('');

    return '' +
      '<article class="kid-card" id="card-' + esc(def.id) + '" data-kid="' + esc(def.id) + '" data-type="' + esc(def.type || 'fire') + '">' +
        '<div class="kid-card__head">' +
          '<div class="poke">' +
            '<img src="' + esc(def.artwork) + '" alt="' + esc(def.pokemon) + ' 그림" loading="lazy" width="86" height="86" ' +
                 'data-emoji="' + esc(def.emoji || '✨') + '">' +
          '</div>' +
          '<div class="kid-card__id">' +
            '<h3 class="kid-card__name">' + esc(def.name) +
              '<span class="kid-card__poke">' + esc(def.emoji || '') + ' ' + esc(def.pokemon) + '</span>' +
            '</h3>' +
            '<p class="kid-card__meta">' + esc(def.role || '') + ' · ' + esc(def.typeLabel || '') + ' 타입</p>' +
            '<p class="kid-card__cheer">' + esc(def.cheer || '') + '</p>' +
            '<div class="level-row">' +
              '<p class="level">Lv.' + level + ' <span>' + doneCount + '/' + kid.quests.length + ' 완료</span></p>' +
            '</div>' +
          '</div>' +
        '</div>' +
        '<div class="xp" role="progressbar" aria-valuemin="0" aria-valuemax="' + LEVEL_XP + '" aria-valuenow="' + progress + '" ' +
             'aria-label="' + esc(def.name) + ' 다음 레벨까지">' +
          '<div class="xp__bar" data-width="' + progress + '" style="width:0%"></div>' +
        '</div>' +
        '<p class="xp__text">' + progress + ' / ' + LEVEL_XP + ' XP · 다음 레벨까지 ' + remaining + ' XP (누적 ' + xp + ' XP)</p>' +
        '<p class="kid-card__sticker-line"><span aria-hidden="true">⭐</span> 스티커 ' + kid.stickers + '장 · ' +
          '<span aria-hidden="true">🏡</span> 마을 ' + kid.box.length + '마리</p>' +
        '<div class="quests">' + (quests || '<p class="empty">퀘스트를 추가해 보세요.</p>') + '</div>' +
        '<form class="quest-add" data-kid="' + esc(def.id) + '" autocomplete="off">' +
          '<input type="text" name="text" maxlength="40" placeholder="새 퀘스트 (예: 책 10쪽 읽기)" aria-label="새 퀘스트">' +
          '<input type="number" name="xp" min="1" max="100" step="5" value="10" aria-label="획득 XP">' +
          '<button type="submit" class="btn">+ 퀘스트 추가</button>' +
        '</form>' +
        '<div class="kid-card__foot">' +
          (allDone ? '<p class="kid-card__allclear">🎉 오늘 올클리어!</p>' : '<span></span>') +
          '<div class="kid-card__foot-right">' +
            '<button type="button" class="btn btn--ghost" data-action="go-village" data-kid="' + esc(def.id) + '">포켓몬 마을</button>' +
            '<button type="button" class="btn btn--text" data-action="reset" data-kid="' + esc(def.id) + '">하루 초기화</button>' +
          '</div>' +
        '</div>' +
      '</article>';
  }

  function animateBars(root) {
    $$('.xp__bar', root || document).forEach(function (bar) {
      var width = bar.getAttribute('data-width') || '0';
      if (bar.__drawn === width) return;
      bar.__drawn = width;
      window.requestAnimationFrame(function () { bar.style.width = width + '%'; });
    });
  }

  function fixImages(root) {
    $$('.poke img', root || document).forEach(function (img) {
      if (img.__bound) return;
      img.__bound = true;
      img.addEventListener('error', function () {
        var span = document.createElement('span');
        span.className = 'poke__fallback';
        span.textContent = img.getAttribute('data-emoji') || '✨';
        if (img.parentNode) img.parentNode.replaceChild(span, img);
      });
    });
  }

  function renderKids() {
    var grid = $('#kids-grid');
    if (!grid || !data || !Array.isArray(data.kids)) return;
    grid.innerHTML = data.kids.map(kidCardHtml).join('');
    animateBars(grid);
    fixImages(grid);
  }

  function refreshKid(kidId) {
    var def = kidDef(kidId);
    var current = document.getElementById('card-' + kidId);
    if (!def || !current) return;
    current.outerHTML = kidCardHtml(def);
    var next = document.getElementById('card-' + kidId);
    animateBars(next);
    fixImages(next);
  }

  /* =========================================================
     렌더링 — 포켓몬 (지금 키우는 포켓몬 / 마을 / 최근 스티커)
     ========================================================= */
  function renderNursery() {
    if (!pokeData() || !currentKid) return;
    var kid = state.kids[currentKid];
    var def = kidDef(currentKid);
    if (!kid || !def) return;

    setText('#nursery-kid', def.name + (def.role ? ' · ' + def.role : ''));
    var badge = $('#sticker-badge');
    if (badge) badge.innerHTML = '<span aria-hidden="true">⭐</span> 스티커 ' + kid.stickers + '장';

    var fam = familyOf(kid.active.family);
    var stage = fam ? Math.min(kid.active.stage, fam.stages.length) : 0;
    var maxStage = fam ? fam.stages.length : 0;
    var isFinal = !!fam && stage >= maxStage;

    var eggEl = $('#stage-egg');
    var spriteEl = $('#stage-sprite');
    if (eggEl && spriteEl) {
      if (stage === 0) {
        eggEl.hidden = false;
        spriteEl.hidden = true;
        spriteEl.removeAttribute('style');
      } else {
        var dex = fam.stages[stage - 1];
        var info = dexInfo(dex);
        eggEl.hidden = true;
        spriteEl.hidden = false;
        spriteEl.setAttribute('style', spriteStyle(dex, 196));
        spriteEl.setAttribute('role', 'img');
        spriteEl.setAttribute('aria-label', info ? info.name : '포켓몬');
      }
    }

    var stepEl = $('#stage-step');
    if (stepEl) {
      if (stage === 0) stepEl.textContent = '알';
      else if (fam && fam.legendary && stage >= maxStage) stepEl.textContent = '전설의 포켓몬';
      else if (stage >= maxStage) stepEl.textContent = '최종 진화';
      else stepEl.textContent = stage + '단계';
    }

    if (stage === 0) {
      setText('#stage-name', '무슨 포켓몬일까?');
    } else {
      var dInfo = dexInfo(fam.stages[stage - 1]);
      setText('#stage-name', dInfo ? dInfo.name : '포켓몬');
    }
    setText('#stage-no', kid.active.eggNo + '번째 알');

    /* 진행도 */
    var need = isFinal ? 0 : stageCost(fam, stage);
    var pct = isFinal ? 100 : (need ? Math.min(100, Math.round((kid.stickers / need) * 100)) : 0);
    var fill = $('#progress-fill');
    if (fill) fill.style.width = pct + '%';
    var track = $('#progress-track');
    if (track) track.setAttribute('aria-label', isFinal ? '다 키운 포켓몬' : '스티커 ' + kid.stickers + ' / ' + need + '장');

    var verb = stage === 0 ? '부화' : '진화';
    var textEl = $('#progress-text');
    if (textEl) {
      if (isFinal) {
        textEl.textContent = '다 키웠어요! 보관함에 넣고 새 알을 받아요.';
      } else if (kid.stickers >= need) {
        textEl.textContent = '다음: 스티커 ' + need + '장이면 ' + verb + ' · 지금 바로 ' + verb + '할 수 있어요!';
      } else {
        textEl.textContent = '다음: 스티커 ' + need + '장이면 ' + verb + ' · ' + (need - kid.stickers) + '장 더 모아요 (지금 ' + kid.stickers + '장)';
      }
    }

    /* 버튼 */
    var growBtn = $('#btn-grow');
    var boxBtn = $('#btn-box');
    if (growBtn && boxBtn) {
      if (isFinal) {
        growBtn.hidden = true;
        boxBtn.hidden = false;
      } else {
        growBtn.hidden = false;
        boxBtn.hidden = true;
        var locked = kid.stickers < need;
        growBtn.classList.toggle('is-locked', locked);
        growBtn.setAttribute('aria-disabled', locked ? 'true' : 'false');
        growBtn.textContent = (stage === 0 ? '🥚 알 부화하기' : '✨ 진화하기') + ' (스티커 ' + need + '장)';
      }
    }
  }

  function renderVillage() {
    if (!pokeData() || !currentKid) return;
    var kid = state.kids[currentKid];
    var def = kidDef(currentKid);
    if (!kid || !def) return;

    setText('#village-title', def.name + '의 포켓몬 마을');
    setText('#village-count', '다 키운 포켓몬 ' + kid.box.length + '마리');

    var wrap = $('#meadow-figures');
    var empty = $('#meadow-empty');
    var more = $('#meadow-more');
    if (!wrap) return;

    var list = kid.box.slice().sort(function (a, b) {
      return new Date(a.at) - new Date(b.at);
    });

    wrap.innerHTML = list.slice(0, SLOTS.length).map(function (item, i) {
      var slot = SLOTS[i];
      var info = dexInfo(item.dex);
      var size = Math.round(74 * slot.k);
      return '' +
        '<button type="button" class="figure" data-box-id="' + esc(item.id) + '"' +
          ' style="--x:' + slot.x + '%;--y:' + slot.y + '%;--k:' + slot.k + '"' +
          ' aria-label="' + esc(info ? info.name : '포켓몬') + ' 도감 보기">' +
          '<span class="sprite figure__sprite" style="' + spriteStyle(item.dex, size) + '" aria-hidden="true"></span>' +
          '<span class="figure__tag">' + esc(info ? info.name : '???') + '</span>' +
        '</button>';
    }).join('');

    if (empty) empty.hidden = list.length > 0;
    if (more) {
      var extra = Math.max(0, list.length - SLOTS.length);
      more.hidden = extra === 0;
      if (extra) more.textContent = '+' + extra + '마리 더 있어요';
    }
  }

  function renderStickerLog() {
    if (!currentKid || !state.kids[currentKid]) return;
    var kid = state.kids[currentKid];
    var log = kid.stickerLog.slice().sort(function (a, b) {
      return new Date(b.at) - new Date(a.at);
    });

    var weekAgo = new Date().getTime() - 7 * 86400000;
    var week = log.reduce(function (sum, e) {
      return new Date(e.at).getTime() >= weekAgo ? sum + e.amount : sum;
    }, 0);

    setText('#sticker-count', '모은 스티커 ' + (kid.stickerTotal || 0) + '장 · 이번 주 ' + week + '장');

    var list = $('#sticker-log');
    var empty = $('#sticker-empty');
    if (!list) return;

    var todayKey = dateKey();
    list.innerHTML = log.slice(0, 14).map(function (e) {
      var d = new Date(e.at);
      var label = dateKey(d) === todayKey ? '오늘' : (d.getMonth() + 1) + '/' + d.getDate() + ' ' + WEEKDAYS_SHORT[d.getDay()];
      var src = e.src === 'quest' ? '퀘스트' : (e.src === 'parent' ? '부모님' : '보너스');
      return '' +
        '<li class="sticker-row" data-src="' + esc(e.src) + '">' +
          '<span class="sticker-row__date">' + esc(label) + '</span>' +
          '<span class="sticker-row__plus">+' + e.amount + '장</span>' +
          '<span class="sticker-row__reason">' + esc(e.reason) + '</span>' +
          '<span class="sticker-row__src">' + src + '</span>' +
        '</li>';
    }).join('');

    if (empty) empty.hidden = log.length > 0;
  }

  function renderPokemon() {
    renderNursery();
    renderVillage();
    renderStickerLog();
  }

  /* =========================================================
     렌더링 — 오늘 일정 / D-Day / 캘린더
     ========================================================= */
  function renderToday() {
    if (!data || !Array.isArray(data.today)) {
      TODAY_LISTS.forEach(function (sel) { var el = $(sel); if (el) el.innerHTML = ''; });
      return;
    }

    var html = data.today.map(function (item) {
      return '' +
        '<li class="today-item' + (item.emphasis ? ' is-emphasis' : '') + '" data-type="' + esc(item.type || '') + '">' +
          '<span class="today-item__emoji" aria-hidden="true">' + esc(item.emoji || '📌') + '</span>' +
          '<div class="today-item__body">' +
            '<p class="today-item__who">' + esc(item.who || '') + '</p>' +
            '<p class="today-item__title">' + esc(item.title || '') + '</p>' +
            (item.detail ? '<p class="today-item__detail">' + esc(item.detail) + '</p>' : '') +
          '</div>' +
        '</li>';
    }).join('');

    TODAY_LISTS.forEach(function (sel) { var el = $(sel); if (el) el.innerHTML = html; });
  }

  function buildEventIndex() {
    eventIndex = {};
    if (!data || !Array.isArray(data.events)) return;

    data.events.forEach(function (ev) {
      var start = parseKey(ev.date);
      var end = ev.endDate ? parseKey(ev.endDate) : start;
      var cursor = new Date(start.getTime());
      var guard = 0;
      while (cursor <= end && guard < 120) {
        var key = dateKey(cursor);
        if (!eventIndex[key]) eventIndex[key] = [];
        eventIndex[key].push({
          title: ev.title,
          type: ev.type || 'family',
          emoji: ev.emoji || '📌',
          who: ev.who || '',
          time: ev.time || '',
          detail: ev.detail || '',
          isStart: dateKey(cursor) === dateKey(start),
          isEnd: dateKey(cursor) === dateKey(end)
        });
        cursor = addDays(cursor, 1);
        guard += 1;
      }
    });
  }

  function renderDday() {
    if (!data || !Array.isArray(data.dday)) {
      DDAY_LISTS.forEach(function (sel) { var el = $(sel); if (el) el.innerHTML = ''; });
      return;
    }

    var today = new Date();
    var rows = data.dday.map(function (item) {
      var start = parseKey(item.date);
      var end = item.endDate ? parseKey(item.endDate) : start;
      var toStart = dayDiff(start, today);
      var toEnd = dayDiff(end, today);
      var badge = '';
      var cls = '';

      if (toEnd < 0) {
        cls = ' is-past';
        badge = '지남';
      } else if (toStart > 0) {
        badge = 'D-' + toStart;
        cls = toStart <= 3 ? ' is-soon' : '';
      } else if (toStart === 0 && !item.endDate) {
        badge = '오늘';
        cls = ' is-today';
      } else if (toStart <= 0 && toEnd >= 0) {
        badge = '진행 중';
        cls = ' is-today';
      }

      var range = item.endDate
        ? (start.getMonth() + 1) + '/' + start.getDate() + '~' + (end.getMonth() + 1) + '/' + end.getDate()
        : (start.getMonth() + 1) + '/' + start.getDate() + (item.time ? ' ' + item.time : '');

      return { item: item, badge: badge, cls: cls, range: range, toStart: toStart, toEnd: toEnd };
    });

    rows.sort(function (a, b) {
      var aPast = a.toEnd < 0 ? 1 : 0;
      var bPast = b.toEnd < 0 ? 1 : 0;
      if (aPast !== bPast) return aPast - bPast;
      if (a.toStart !== b.toStart) return a.toStart - b.toStart;
      return a.toEnd - b.toEnd;
    });

    var html = rows.map(function (row) {
      return '' +
        '<li class="dday' + row.cls + '">' +
          '<span class="dday__emoji" aria-hidden="true">' + esc(row.item.emoji || '📌') + '</span>' +
          '<div class="dday__body">' +
            '<p class="dday__title">' + esc(row.item.title) + '</p>' +
            '<p class="dday__note">' + esc(row.range) + (row.item.note ? ' · ' + esc(row.item.note) : '') + '</p>' +
          '</div>' +
          '<span class="dday__badge">' + esc(row.badge) + '</span>' +
        '</li>';
    }).join('');

    DDAY_LISTS.forEach(function (sel) { var el = $(sel); if (el) el.innerHTML = html; });
  }

  function renderCalendar() {
    var y = calMonth.y;
    var m = calMonth.m;
    var first = new Date(y, m, 1);
    var startPad = first.getDay();
    var daysInMonth = new Date(y, m + 1, 0).getDate();
    var todayK = dateKey();

    var html = '';
    for (var i = 0; i < startPad; i += 1) {
      html += '<span class="day is-blank" aria-hidden="true"></span>';
    }

    for (var d = 1; d <= daysInMonth; d += 1) {
      var key = y + '-' + pad(m + 1) + '-' + pad(d);
      var weekday = new Date(y, m, d).getDay();
      var events = eventIndex[key] || [];
      var has = events.length > 0;
      var classes = ['day'];
      if (weekday === 0) classes.push('is-sun');
      if (weekday === 6) classes.push('is-sat');
      if (has) classes.push('has-events');
      if (key === todayK) classes.push('is-today');
      if (key === selectedDate) classes.push('is-selected');

      var dots = events.slice(0, 3).map(function (ev) {
        return '<span class="dot dot--' + (ev.type === 'school' ? 'school' : 'family') + '"></span>';
      }).join('');

      html += '' +
        '<button type="button" class="' + classes.join(' ') + '" data-date="' + key + '" data-events="' + (has ? '1' : '0') + '" ' +
        'aria-label="' + (m + 1) + '월 ' + d + '일' + (has ? ', 일정 ' + events.length + '개' : '') + '"' +
        (key === todayK ? ' aria-current="date"' : '') + '>' +
          '<span aria-hidden="true">' + d + '</span>' +
          '<span class="day__dots" aria-hidden="true">' + dots + '</span>' +
        '</button>';
    }

    CAL_TARGETS.forEach(function (target) {
      var grid = $(target.grid);
      if (grid) grid.innerHTML = html;
      setText(target.month, y + '년 ' + (m + 1) + '월');
    });
    renderDayDetail();
  }

  function renderDayDetail() {
    var key = selectedDate || dateKey();
    var d = parseKey(key);
    var events = eventIndex[key] || [];
    var todayK = dateKey();

    var head = '<p class="day-detail__date">' + (d.getMonth() + 1) + '월 ' + d.getDate() + '일 ' +
      WEEKDAYS[d.getDay()] + (key === todayK ? ' · 오늘' : '') + '</p>';

    var body;
    if (!events.length) {
      body = head + '<p class="day-detail__empty">이 날은 등록된 일정이 없어요. 편안한 하루!</p>';
    } else {
      body = head + events.map(function (ev) {
        return '' +
          '<p class="day-detail__item">' +
            '<span aria-hidden="true">' + esc(ev.emoji || '📌') + '</span>' +
            (ev.who ? '<span class="day-detail__who">' + esc(ev.who) + '</span>' : '') +
            '<strong>' + esc(ev.title) + '</strong>' +
            (ev.time ? '<span>' + esc(ev.time) + '</span>' : '') +
            (ev.detail ? '<span class="dday__note">' + esc(ev.detail) + '</span>' : '') +
          '</p>';
      }).join('');
    }

    CAL_TARGETS.forEach(function (target) {
      var box = $(target.detail);
      if (box) box.innerHTML = body;
    });
  }

  /* =========================================================
     렌더링 — 위시리스트 / 우체통
     ========================================================= */
  function renderWishlist() {
    var list = $('#wishlist');
    var empty = $('#wish-empty');
    var totalEl = $('#wish-total');
    var clearBtn = $('#wish-clear-done');
    if (!list) return;

    if (!state.wishlist.length) {
      list.innerHTML = '';
      if (empty) empty.hidden = false;
      if (totalEl) totalEl.hidden = true;
      if (clearBtn) clearBtn.hidden = true;
      return;
    }

    if (empty) empty.hidden = true;

    var sorted = state.wishlist.slice().sort(function (a, b) {
      if (a.done !== b.done) return a.done ? 1 : -1;
      return new Date(b.createdAt) - new Date(a.createdAt);
    });

    list.innerHTML = sorted.map(function (w) {
      return '' +
        '<li class="wish' + (w.done ? ' is-done' : '') + '" data-id="' + esc(w.id) + '">' +
          '<input type="checkbox" data-action="wish-toggle" aria-label="' + esc(w.item) + ' 구매 완료"' + (w.done ? ' checked' : '') + '>' +
          '<div class="wish__body">' +
            '<div class="wish__top">' +
              (w.who ? '<span class="wish__who">' + esc(w.who) + '</span>' : '') +
              '<span class="wish__item">' + esc(w.item) + '</span>' +
              (w.price ? '<span class="wish__price">' + w.price.toLocaleString('ko-KR') + '원</span>' : '') +
            '</div>' +
            (w.memo ? '<p class="wish__memo">' + esc(w.memo) + '</p>' : '') +
          '</div>' +
          '<button type="button" class="note__del" data-action="wish-del" aria-label="' + esc(w.item) + ' 삭제">✕</button>' +
        '</li>';
    }).join('');

    var openItems = state.wishlist.filter(function (w) { return !w.done; });
    var sum = openItems.reduce(function (acc, w) { return acc + (w.price || 0); }, 0);

    if (totalEl) {
      if (openItems.length && sum > 0) {
        totalEl.hidden = false;
        totalEl.textContent = '남은 ' + openItems.length + '개 · 합계 ' + sum.toLocaleString('ko-KR') + '원';
      } else if (openItems.length) {
        totalEl.hidden = false;
        totalEl.textContent = '남은 ' + openItems.length + '개';
      } else {
        totalEl.hidden = true;
      }
    }
    if (clearBtn) clearBtn.hidden = !state.wishlist.some(function (w) { return w.done; });
  }

  function renderQuickNotes() {
    if (!data) return;
    var items = Array.isArray(data.quickNotes) ? data.quickNotes : ['전화할게', '도와주세요'];
    var html = items.map(function (text) {
      return '<button type="button" class="chip" data-quick="' + esc(text) + '">' + esc(text) + '</button>';
    }).join('');
    QUICK_BOXES.forEach(function (sel) { var el = $(sel); if (el) el.innerHTML = html; });
  }

  function renderNotes() {
    var sorted = state.notes.slice().sort(function (a, b) {
      return new Date(b.createdAt) - new Date(a.createdAt);
    });

    var html = sorted.map(function (n) {
      return '' +
        '<li class="note" data-id="' + esc(n.id) + '">' +
          '<span class="note__avatar" aria-hidden="true">📝</span>' +
          '<div class="note__body">' +
            '<div class="note__head">' +
              '<span class="note__from">' + esc(n.from || '가족') + '</span>' +
              '<span class="note__time">' + esc(relTime(n.createdAt)) + '</span>' +
            '</div>' +
            '<p class="note__text">' + esc(n.text) + '</p>' +
          '</div>' +
          '<button type="button" class="note__del" data-action="note-del" aria-label="메모 삭제">✕</button>' +
        '</li>';
    }).join('');

    NOTE_LISTS.forEach(function (sel) {
      var list = $(sel);
      if (list) list.innerHTML = html;
    });
    NOTE_EMPTY.forEach(function (sel) {
      var empty = $(sel);
      if (empty) empty.hidden = state.notes.length > 0;
    });
  }

  function renderSelects() {
    var options = (data && Array.isArray(data.wishlistWho)) ? data.wishlistWho : ['가족'];
    var html = options.map(function (name) {
      return '<option value="' + esc(name) + '">' + esc(name) + '</option>';
    }).join('');

    ['#wish-who', '#note-from', '#note-from-2'].forEach(function (sel) {
      var el = $(sel);
      if (el && !el.options.length) el.innerHTML = html;
    });
  }

  function renderSyncChip(mode, extra) {
    var chip = $('#sync-chip');
    if (!chip) return;
    chip.dataset.state = mode;
    var text = STATE_ICON[mode] || STATE_ICON.local;
    if (extra) text += ' ' + extra;
    if (!sync.enabled) text = STATE_ICON.local;
    chip.textContent = text;
  }

  function renderAll() {
    renderWeather();
    renderKids();
    renderToday();
    renderDday();
    renderCalendar();
    renderWishlist();
    renderNotes();
    renderPokemon();
    syncTabState();
    renderSyncChip(sync.enabled ? 'synced' : 'local');
  }

  /* =========================================================
     스티커 · 포켓몬 동작
     ========================================================= */
  function addSticker(kidId, amount, reason, src, questId) {
    var kid = state.kids[kidId];
    if (!kid || amount <= 0) return;
    kid.stickers += amount;
    kid.stickerTotal = (kid.stickerTotal || 0) + amount;
    kid.stickerLog.push({
      id: uid(),
      at: new Date().toISOString(),
      amount: amount,
      reason: reason,
      src: src || 'parent',
      questId: questId || ''
    });
    if (kid.stickerLog.length > LOG_LIMIT) kid.stickerLog = kid.stickerLog.slice(-LOG_LIMIT);
  }

  function removeQuestSticker(kidId, questId) {
    var kid = state.kids[kidId];
    if (!kid) return 0;
    var todayKey = dateKey();
    var removed = 0;
    kid.stickerLog = kid.stickerLog.filter(function (e) {
      var isToday = dateKey(new Date(e.at)) === todayKey;
      if (e.src === 'quest' && e.questId === questId && isToday) {
        removed += e.amount;
        return false;
      }
      return true;
    });
    if (removed) {
      kid.stickers = Math.max(0, kid.stickers - removed);
      kid.stickerTotal = Math.max(0, (kid.stickerTotal || 0) - removed);
    }
    return removed;
  }

  function growPokemon() {
    var kid = state.kids[currentKid];
    var fam = kid ? familyOf(kid.active.family) : null;
    if (!kid || !fam) return;

    var stage = kid.active.stage;
    var maxStage = fam.stages.length;
    if (stage >= maxStage) { boxPokemon(); return; }

    var need = stageCost(fam, stage);
    if (kid.stickers < need) {
      toast('스티커 ' + (need - kid.stickers) + '장이 더 필요해요. 퀘스트를 끝내거나 부모님 스티커를 받아요!', 'level');
      return;
    }

    kid.stickers -= need;
    kid.active.stage += 1;

    var info = dexInfo(fam.stages[kid.active.stage - 1]);
    var name = info ? info.name : '포켓몬';

    touch();
    renderPokemon();
    renderKids();

    if (kid.active.stage >= maxStage) {
      toast('🎉 ' + iGa(name) + ' 최종 진화했어요! [보관함에 넣고 새 알 받기]를 눌러요', 'level');
    } else if (stage === 0) {
      toast('🥚 알에서 ' + iGa(name) + ' 태어났어요!', 'level');
    } else {
      toast('✨ ' + ro(name) + ' 진화했어요!', 'level');
    }
  }

  function boxPokemon() {
    var kid = state.kids[currentKid];
    var fam = kid ? familyOf(kid.active.family) : null;
    if (!kid || !fam) return;

    var finalDex = fam.stages[fam.stages.length - 1];
    var info = dexInfo(finalDex);

    kid.box.push({
      id: uid(),
      dex: finalDex,
      family: fam.id,
      at: new Date().toISOString()
    });

    var nextFamily = pickEggFamily(currentKid);
    kid.active = {
      family: nextFamily,
      stage: 0,
      eggNo: (Number(kid.active.eggNo) || 1) + 1,
      since: new Date().toISOString()
    };

    touch();
    renderPokemon();
    renderKids();
    toast('🎉 ' + iGa(info ? info.name : '포켓몬') + ' 마을에 들어왔어요! 새 알을 받았어요 🥚', 'level');
  }

  function giveStickers(amount) {
    var kid = state.kids[currentKid];
    if (!kid) return;
    var n = Math.max(1, Math.floor(Number(amount) || 1));
    addSticker(currentKid, n, '부모님 칭찬 스티커', 'parent');
    touch();
    renderPokemon();
    renderKids();
    toast('⭐ ' + kidDef(currentKid).name + '에게 스티커 ' + n + '장을 줬어요');
  }

  /* ---------- 보관함 모달 ---------- */
  function typeBadge(type) {
    return '<span class="type-chip" data-type="' + esc(type) + '">' + esc(typeLabel(type)) + '</span>';
  }

  function sortBox(items, mode) {
    var out = items.slice();
    if (mode === 'dex') out.sort(function (a, b) { return a.dex - b.dex; });
    else if (mode === 'name') out.sort(function (a, b) {
      var na = (dexInfo(a.dex) || {}).name || '';
      var nb = (dexInfo(b.dex) || {}).name || '';
      return na.localeCompare(nb, 'ko');
    });
    else if (mode === 'old') out.sort(function (a, b) { return new Date(a.at) - new Date(b.at); });
    else out.sort(function (a, b) { return new Date(b.at) - new Date(a.at); });
    return out;
  }

  function showBoxDetail(id) {
    var box = $('#box-detail');
    if (!box) return;
    var kid = state.kids[currentKid];
    var item = null;
    if (kid) kid.box.forEach(function (b) { if (b.id === id) item = b; });
    if (!item) { box.hidden = true; box.innerHTML = ''; return; }

    var info = dexInfo(item.dex);
    var fam = familyOf(item.family);
    var d = new Date(item.at);
    var line = fam ? fam.stages.map(function (dx) {
      var n = dexInfo(dx);
      return n ? n.name : '?';
    }).join(' → ') : '';

    box.hidden = false;
    box.innerHTML = '' +
      '<span class="sprite box-detail__sprite" style="' + spriteStyle(item.dex, 124) + '" aria-hidden="true"></span>' +
      '<div class="box-detail__body">' +
        '<p class="box-detail__name">' + esc(info ? info.name : '포켓몬') + ' <span>No.' + item.dex + '</span></p>' +
        '<p class="box-detail__line">' + esc(line) + '</p>' +
        '<p class="box-detail__meta">' + typeBadge(info ? info.type : 'normal') + ' ' +
          d.getFullYear() + '년 ' + (d.getMonth() + 1) + '월 ' + d.getDate() + '일 보관</p>' +
      '</div>';
  }

  function renderBoxGrid(focusId) {
    var kid = state.kids[currentKid];
    if (!kid) return;
    var select = $('#box-sort');
    var mode = select ? select.value : 'recent';
    var items = sortBox(kid.box, mode);

    var def = kidDef(currentKid);
    setText('#box-title', (def ? def.name : '아이') + '의 포켓몬 보관함');
    setText('#box-lead', '다 키운 포켓몬 ' + items.length + '마리');

    var grid = $('#box-grid');
    if (grid) {
      grid.innerHTML = items.map(function (item) {
        var info = dexInfo(item.dex);
        var d = new Date(item.at);
        return '' +
          '<button type="button" class="box-card' + (item.id === focusId ? ' is-focus' : '') + '" data-box-id="' + esc(item.id) + '">' +
            '<span class="sprite box-card__sprite" style="' + spriteStyle(item.dex, 92) + '" aria-hidden="true"></span>' +
            '<span class="box-card__name">' + esc(info ? info.name : '포켓몬') + '</span>' +
            '<span class="box-card__meta">No.' + item.dex + ' · ' + (d.getMonth() + 1) + '/' + d.getDate() + '</span>' +
            typeBadge(info ? info.type : 'normal') +
          '</button>';
      }).join('');
    }

    var empty = $('#box-empty');
    if (empty) empty.hidden = items.length > 0;
    showBoxDetail(focusId);
  }

  function openBox(focusId) {
    if (!currentKid || !state.kids[currentKid]) return;
    renderBoxGrid(focusId || '');
    openModal('box-modal');
  }

  /* =========================================================
     퀘스트 동작
     ========================================================= */
  function toggleQuest(kidId, questId, checked) {
    var kid = state.kids[kidId];
    if (!kid) return;
    var quest = kid.quests.filter(function (q) { return q.id === questId; })[0];
    if (!quest) return;
    if (quest.done === checked) return;

    var beforeLevel = levelOf(kid.xp);
    quest.done = checked;
    kid.xp = Math.max(0, kid.xp + (checked ? quest.xp : -quest.xp));

    if (checked) addSticker(kidId, 1, '퀘스트: ' + quest.text, 'quest', questId);
    else removeQuestSticker(kidId, questId);

    var afterLevel = levelOf(kid.xp);
    var def = kidDef(kidId);
    var name = def ? def.name : '';

    touch();
    refreshKid(kidId);
    if (view === 'pokemon' && kidId === currentKid) renderPokemon();

    if (afterLevel > beforeLevel) {
      toast('🎉 ' + name + ' Lv.' + afterLevel + ' 달성!', 'level');
    } else if (checked) {
      var allDone = kid.quests.length > 0 && kid.quests.every(function (q) { return q.done; });
      toast('⭐ 스티커 +1장 (퀘스트 완료)' + (allDone ? ' · 🏆 오늘 올클리어!' : ''), 'level');
    }
  }

  function addQuest(kidId, text, xp) {
    var kid = state.kids[kidId];
    if (!kid) return;
    var label = String(text || '').trim();
    if (!label) return;
    kid.quests.push({
      id: 'custom-' + uid(),
      text: label.slice(0, 40),
      xp: Math.min(100, Math.max(1, Number(xp) || 10)),
      done: false,
      custom: true
    });
    touch();
    refreshKid(kidId);
    toast('퀘스트를 추가했어요: ' + label);
  }

  function deleteQuest(kidId, questId) {
    var kid = state.kids[kidId];
    if (!kid) return;
    var quest = kid.quests.filter(function (q) { return q.id === questId; })[0];
    if (!quest) return;
    if (quest.done) {
      kid.xp = Math.max(0, kid.xp - quest.xp);
      removeQuestSticker(kidId, questId);
    }
    kid.quests = kid.quests.filter(function (q) { return q.id !== questId; });
    touch();
    refreshKid(kidId);
    if (view === 'pokemon' && kidId === currentKid) renderPokemon();
    toast('퀘스트를 지웠어요');
  }

  function resetKid(kidId) {
    var kid = state.kids[kidId];
    if (!kid) return;
    var hadDone = kid.quests.some(function (q) { return q.done; });
    if (!hadDone) { toast('이미 깨끗한 상태예요'); return; }
    kid.quests.forEach(function (q) {
      if (q.done) removeQuestSticker(kidId, q.id);
      q.done = false;
    });
    kid.resetDate = dateKey();
    touch();
    refreshKid(kidId);
    if (view === 'pokemon' && kidId === currentKid) renderPokemon();
    toast('오늘 퀘스트를 초기화했어요 (XP·스티커는 오늘 받은 만큼 돌아가요)');
  }

  /* =========================================================
     동기화 (Firebase Realtime Database REST)
     ========================================================= */
  function normalizeDbUrl(raw) {
    var url = String(raw || '').trim();
    if (!url) return '';
    if (!/^https?:\/\//i.test(url)) url = 'https://' + url;
    return url.replace(/\/+$/, '');
  }

  function dbEndpoint() {
    return sync.url ? sync.url + '/family.json' : '';
  }

  function schedulePush() {
    if (!sync.enabled || !sync.url) return;
    if (pushTimer) window.clearTimeout(pushTimer);
    pushTimer = window.setTimeout(function () { pushState(); }, PUSH_DEBOUNCE);
  }

  function pushState() {
    if (!sync.enabled || !sync.url) return;
    var payload = JSON.stringify(state);
    if (payload === lastPayload) return;
    renderSyncChip('syncing');

    window.fetch(dbEndpoint(), {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: payload
    }).then(function (res) {
      if (!res.ok) throw new Error('HTTP ' + res.status);
      lastPayload = payload;
      var now = new Date();
      renderSyncChip('synced', pad(now.getHours()) + ':' + pad(now.getMinutes()));
    }).catch(function () {
      renderSyncChip('error');
    });
  }

  function pullState() {
    if (!sync.enabled || !sync.url) return;
    window.fetch(dbEndpoint() + '?ts=' + Date.now(), { cache: 'no-store' })
      .then(function (res) {
        if (!res.ok) throw new Error('HTTP ' + res.status);
        return res.json();
      })
      .then(function (remote) {
        if (!remote || !remote.kids) { renderSyncChip('synced'); return; }
        var remoteTs = Number(remote._ts) || 0;
        var localTs = Number(state._ts) || 0;
        if (remoteTs > localTs + 400) {
          state = normalizeState(remote);
          saveLocal();
          lastPayload = JSON.stringify(state);
          renderAll();
          renderSelects();
          var now = new Date();
          renderSyncChip('synced', pad(now.getHours()) + ':' + pad(now.getMinutes()));
        } else {
          renderSyncChip('synced');
        }
      })
      .catch(function () {
        renderSyncChip('error');
      });
  }

  function startSync() {
    if (pollTimer) { window.clearInterval(pollTimer); pollTimer = null; }
    if (!sync.enabled || !sync.url) { renderSyncChip('local'); return; }
    pullState();
    pushState();
    pollTimer = window.setInterval(pullState, POLL_MS);
  }

  function setModalStatus(text, mode) {
    var el = $('#sync-modal-status');
    if (!el) return;
    el.textContent = text;
    if (mode) el.dataset.state = mode;
    else el.removeAttribute('data-state');
  }

  function openModal(id) {
    var modal = document.getElementById(id);
    if (!modal) return;
    modal.hidden = false;
  }

  function closeModal(id) {
    var modal = document.getElementById(id);
    if (modal) modal.hidden = true;
  }

  function openSyncModal() {
    openModal('sync-modal');
    var input = $('#sync-url');
    if (input) {
      input.value = sync.url;
      window.setTimeout(function () { input.focus(); }, 60);
    }
    setModalStatus(sync.enabled
      ? '연결됨 · 5초마다 다른 기기와 맞춰요. (' + sync.url + ')'
      : '아직 연결하지 않았어요. 비워두면 이 기기에만 저장됩니다.', sync.enabled ? 'ok' : '');
  }

  function saveSync() {
    var input = $('#sync-url');
    var url = normalizeDbUrl(input ? input.value : '');
    if (!url) {
      setModalStatus('주소를 입력해 주세요. 주소를 비우려면 [연결 해제]를 누르세요.', 'error');
      return;
    }
    if (!/^https?:\/\/[^\s]+$/i.test(url)) {
      setModalStatus('주소 형식이 올바르지 않아요. https://…firebaseio.com 처럼 넣어주세요.', 'error');
      return;
    }

    setModalStatus('연결을 확인하는 중…');

    window.fetch(url + '/family.json?probe=' + Date.now(), { cache: 'no-store' })
      .then(function (res) {
        if (res.status === 401 || res.status === 403) {
          throw new Error('권한 없음(규칙 확인 필요)');
        }
        if (!res.ok && res.status !== 404) throw new Error('HTTP ' + res.status);
        return res.text();
      })
      .then(function () {
        sync = { url: url, enabled: true };
        persistSync();
        lastPayload = '';
        startSync();
        setModalStatus('연결됐어요! 이제 다른 기기와 5초마다 맞춰집니다.', 'ok');
        renderSyncChip('syncing');
        toast('실시간 동기화를 켰어요');
        closeModal('sync-modal');
      })
      .catch(function (err) {
        setModalStatus('연결하지 못했어요: ' + (err && err.message ? err.message : '주소 확인 필요') +
          ' · Firebase 규칙에서 읽기/쓰기가 허용돼 있는지 확인해 주세요.', 'error');
      });
  }

  function clearSync() {
    if (pollTimer) { window.clearInterval(pollTimer); pollTimer = null; }
    sync = { url: '', enabled: false };
    persistSync();
    lastPayload = '';
    renderSyncChip('local');
    setModalStatus('연결을 해제했어요. 이 기기에만 저장됩니다.');
    var input = $('#sync-url');
    if (input) input.value = '';
    toast('동기화 연결을 해제했어요');
  }

  /* =========================================================
     대기화면(전체화면)
     ========================================================= */
  function isFullscreen() {
    return !!(document.fullscreenElement || document.webkitFullscreenElement);
  }

  function setWallButton(on) {
    var btn = $('#btn-fullscreen');
    if (!btn) return;
    btn.setAttribute('aria-pressed', on ? 'true' : 'false');
    btn.innerHTML = '<span class="btn__icon" aria-hidden="true">' + (on ? '🚪' : '🖥️') + '</span> ' +
      (on ? '대기화면 나가기' : '대기화면');
  }

  function toggleWall() {
    var on = !document.body.classList.contains('wall-mode');
    document.body.classList.toggle('wall-mode', on);
    setWallButton(on);

    try {
      if (on && !isFullscreen()) {
        var root = document.documentElement;
        var req = root.requestFullscreen || root.webkitRequestFullscreen;
        if (req) {
          var result = req.call(root);
          if (result && typeof result.catch === 'function') result.catch(function () {});
        }
      } else if (!on && isFullscreen()) {
        var exit = document.exitFullscreen || document.webkitExitFullscreen;
        if (exit) {
          var r2 = exit.call(document);
          if (r2 && typeof r2.catch === 'function') r2.catch(function () {});
        }
      }
    } catch (err) { /* 아이패드 사파리처럼 전체화면이 없는 경우: 화면 모드만 적용 */ }

    if (on) toast('대기화면 모드 · 나가려면 오른쪽 위 버튼이나 ESC');
  }

  /* =========================================================
     이벤트 연결
     ========================================================= */
  function bindKids() {
    var grid = $('#kids-grid');
    if (!grid) return;

    grid.addEventListener('change', function (e) {
      var input = e.target;
      if (!input || input.getAttribute('data-action') !== 'toggle') return;
      var holder = input.closest('.quest');
      var card = input.closest('.kid-card');
      if (!holder || !card) return;
      toggleQuest(card.getAttribute('data-kid'), holder.getAttribute('data-quest'), input.checked);
    });

    grid.addEventListener('click', function (e) {
      var del = e.target.closest ? e.target.closest('[data-action="del-quest"]') : null;
      if (del) {
        e.preventDefault();
        e.stopPropagation();
        var holder = del.closest('.quest');
        var card = del.closest('.kid-card');
        if (holder && card) deleteQuest(card.getAttribute('data-kid'), holder.getAttribute('data-quest'));
        return;
      }
      var reset = e.target.closest ? e.target.closest('[data-action="reset"]') : null;
      if (reset) {
        e.preventDefault();
        resetKid(reset.getAttribute('data-kid'));
        return;
      }
      var village = e.target.closest ? e.target.closest('[data-action="go-village"]') : null;
      if (village) {
        e.preventDefault();
        setView('pokemon', village.getAttribute('data-kid'));
      }
    });

    grid.addEventListener('submit', function (e) {
      var form = e.target;
      if (!form.classList || !form.classList.contains('quest-add')) return;
      e.preventDefault();
      var kidId = form.getAttribute('data-kid');
      var textInput = form.querySelector('input[name="text"]');
      var xpInput = form.querySelector('input[name="xp"]');
      addQuest(kidId, textInput ? textInput.value : '', xpInput ? xpInput.value : 10);
    });
  }

  function bindPokemon() {
    var root = $('#view-pokemon');
    if (!root) return;

    root.addEventListener('click', function (e) {
      var target = e.target;
      if (target.closest && target.closest('#btn-grow')) { growPokemon(); return; }
      if (target.closest && target.closest('#btn-box')) { boxPokemon(); return; }
      if (target.closest && target.closest('#btn-box-list')) { openBox(''); return; }

      var give = target.closest ? target.closest('[data-give]') : null;
      if (give) { giveStickers(give.getAttribute('data-give')); return; }

      var fig = target.closest ? target.closest('[data-box-id]') : null;
      if (fig) { openBox(fig.getAttribute('data-box-id')); }
    });
  }

  function bindBoxModal() {
    var grid = $('#box-grid');
    if (grid) {
      grid.addEventListener('click', function (e) {
        var card = e.target.closest ? e.target.closest('[data-box-id]') : null;
        if (!card) return;
        renderBoxGrid(card.getAttribute('data-box-id'));
      });
    }
    var sort = $('#box-sort');
    if (sort) sort.addEventListener('change', function () { renderBoxGrid(''); });
  }

  function bindCalendar() {
    CAL_TARGETS.forEach(function (target) {
      var grid = $(target.grid);
      if (grid) {
        grid.addEventListener('click', function (e) {
          var btn = e.target.closest ? e.target.closest('.day') : null;
          if (!btn || btn.classList.contains('is-blank')) return;
          var key = btn.getAttribute('data-date');
          if (!key) return;
          selectedDate = key;
          CAL_TARGETS.forEach(function (t) {
            var g = $(t.grid);
            if (!g) return;
            $$('.day', g).forEach(function (d) { d.classList.remove('is-selected'); });
          });
          $$('.day', grid).forEach(function (d) {
            if (d.getAttribute('data-date') === key) d.classList.add('is-selected');
          });
          renderDayDetail();
        });
      }

      var prev = $(target.prev);
      if (prev) {
        prev.addEventListener('click', function () {
          calMonth = calMonth.m === 0 ? { y: calMonth.y - 1, m: 11 } : { y: calMonth.y, m: calMonth.m - 1 };
          renderCalendar();
        });
      }
      var next = $(target.next);
      if (next) {
        next.addEventListener('click', function () {
          calMonth = calMonth.m === 11 ? { y: calMonth.y + 1, m: 0 } : { y: calMonth.y, m: calMonth.m + 1 };
          renderCalendar();
        });
      }
    });
  }

  function bindWishlist() {
    var wishForm = $('#wish-form');
    if (wishForm) {
      wishForm.addEventListener('submit', function (e) {
        e.preventDefault();
        var who = $('#wish-who');
        var item = $('#wish-item');
        var price = $('#wish-price');
        var memo = $('#wish-memo');
        var name = item ? item.value.trim() : '';
        if (!name) { if (item) item.focus(); return; }

        state.wishlist.push({
          id: uid(),
          who: who ? who.value : '',
          item: name.slice(0, 60),
          memo: memo ? memo.value.trim().slice(0, 80) : '',
          price: price ? Math.max(0, Number(price.value) || 0) : 0,
          done: false,
          createdAt: new Date().toISOString()
        });

        if (item) item.value = '';
        if (price) price.value = '';
        if (memo) memo.value = '';
        if (item) item.focus();

        touch();
        renderWishlist();
        toast('위시리스트에 담았어요: ' + name);
      });
    }

    var wishList = $('#wishlist');
    if (wishList) {
      wishList.addEventListener('change', function (e) {
        var input = e.target;
        if (!input || input.getAttribute('data-action') !== 'wish-toggle') return;
        var row = input.closest('.wish');
        if (!row) return;
        var id = row.getAttribute('data-id');
        state.wishlist.forEach(function (w) { if (w.id === id) w.done = input.checked; });
        touch();
        renderWishlist();
      });

      wishList.addEventListener('click', function (e) {
        var del = e.target.closest ? e.target.closest('[data-action="wish-del"]') : null;
        if (!del) return;
        var row = del.closest('.wish');
        if (!row) return;
        var id = row.getAttribute('data-id');
        state.wishlist = state.wishlist.filter(function (w) { return w.id !== id; });
        touch();
        renderWishlist();
      });
    }

    var clearDone = $('#wish-clear-done');
    if (clearDone) {
      clearDone.addEventListener('click', function () {
        state.wishlist = state.wishlist.filter(function (w) { return !w.done; });
        touch();
        renderWishlist();
        toast('산 것들을 지웠어요');
      });
    }
  }

  function bindNotes() {
    NOTE_FORMS.forEach(function (spec) {
      var form = $(spec.form);
      if (form) {
        form.addEventListener('submit', function (e) {
          e.preventDefault();
          var from = $(spec.from);
          var text = $(spec.text);
          var value = text ? text.value.trim() : '';
          if (!value) { if (text) text.focus(); return; }

          state.notes.push({
            id: uid(),
            from: from ? from.value : '',
            text: value.slice(0, 120),
            createdAt: new Date().toISOString()
          });

          if (text) { text.value = ''; text.focus(); }
          touch();
          renderNotes();
          toast('메모를 남겼어요');
        });
      }
    });

    QUICK_BOXES.forEach(function (sel) {
      var quick = $(sel);
      if (!quick) return;
      quick.addEventListener('click', function (e) {
        var chip = e.target.closest ? e.target.closest('[data-quick]') : null;
        if (!chip) return;
        var value = chip.getAttribute('data-quick');
        var rootForm = quick.parentNode ? quick.parentNode.querySelector('select') : null;
        state.notes.push({
          id: uid(),
          from: rootForm ? rootForm.value : '',
          text: value,
          createdAt: new Date().toISOString()
        });
        touch();
        renderNotes();
        toast('보냈어요: ' + value);
      });
    });

    NOTE_LISTS.forEach(function (sel) {
      var list = $(sel);
      if (!list) return;
      list.addEventListener('click', function (e) {
        var del = e.target.closest ? e.target.closest('[data-action="note-del"]') : null;
        if (!del) return;
        var row = del.closest('.note');
        if (!row) return;
        var id = row.getAttribute('data-id');
        state.notes = state.notes.filter(function (n) { return n.id !== id; });
        touch();
        renderNotes();
      });
    });
  }

  function bindEvents() {
    bindKids();
    bindPokemon();
    bindBoxModal();
    bindCalendar();
    bindWishlist();
    bindNotes();

    /* 상단 탭 */
    var tabbar = $('#tabbar');
    if (tabbar) {
      tabbar.addEventListener('click', function (e) {
        var btn = e.target.closest ? e.target.closest('.tab') : null;
        if (!btn) return;
        var k = btn.getAttribute('data-kid');
        var v = btn.getAttribute('data-view');
        if (k) setView('pokemon', k);
        else if (v) setView(v);
      });
    }

    /* 모달 닫기 */
    $$('[data-close]').forEach(function (el) {
      el.addEventListener('click', function () { closeModal(el.getAttribute('data-close')); });
    });

    var btnSync = $('#btn-sync');
    if (btnSync) btnSync.addEventListener('click', openSyncModal);

    var syncSave = $('#sync-save');
    if (syncSave) syncSave.addEventListener('click', saveSync);

    var syncClear = $('#sync-clear');
    if (syncClear) syncClear.addEventListener('click', clearSync);

    var syncInput = $('#sync-url');
    if (syncInput) {
      syncInput.addEventListener('keydown', function (e) {
        if (e.key === 'Enter') { e.preventDefault(); saveSync(); }
      });
    }

    var btnFull = $('#btn-fullscreen');
    if (btnFull) btnFull.addEventListener('click', toggleWall);

    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') {
        var open = $$('.modal').filter(function (m) { return !m.hidden; });
        if (open.length) {
          open.forEach(function (m) { m.hidden = true; });
          return;
        }
        if (document.body.classList.contains('wall-mode')) toggleWall();
      }
    });

    document.addEventListener('fullscreenchange', function () {
      if (!isFullscreen() && document.body.classList.contains('wall-mode')) {
        document.body.classList.remove('wall-mode');
        setWallButton(false);
      }
    });

    /* 다른 창에서의 변경 반영 */
    window.addEventListener('storage', function (e) {
      if (e.key !== STORAGE_KEY || !e.newValue) return;
      try {
        var incoming = JSON.parse(e.newValue);
        if (!incoming || !incoming.kids) return;
        if ((Number(incoming._ts) || 0) <= (Number(state._ts) || 0)) return;
        state = normalizeState(incoming);
        renderAll();
      } catch (err) { /* 무시 */ }
    });

    window.addEventListener('hashchange', function () {
      readHash();
    });

    window.addEventListener('online', function () { if (sync.enabled) pullState(); });
    window.addEventListener('beforeunload', function () { if (sync.enabled) pushState(); });
  }

  /* =========================================================
     시작
     ========================================================= */
  function start() {
    sync = loadSync();

    var now = new Date();
    calMonth = { y: now.getFullYear(), m: now.getMonth() };
    selectedDate = dateKey(now);

    renderClock();
    if (clockTimer) window.clearInterval(clockTimer);
    clockTimer = window.setInterval(renderClock, 5000);

    window.fetch('data.json', { cache: 'no-store' })
      .then(function (res) {
        if (!res.ok) throw new Error('HTTP ' + res.status);
        return res.json();
      })
      .then(function (json) {
        data = json;
        bootData();
      })
      .catch(function () {
        var banner = $('#data-banner');
        if (banner) banner.hidden = false;
        data = null;
        bootData();
      });
  }

  function bootData() {
    var stored = null;
    try {
      var raw = window.localStorage.getItem(STORAGE_KEY);
      if (raw) stored = JSON.parse(raw);
    } catch (err) { stored = null; }

    state = normalizeState(stored || { _ts: Date.now() });

    if (data && Array.isArray(data.kids) && data.kids.length) {
      currentKid = data.kids[0].id;
    }
    if (!currentKid) currentKid = 'idun';

    var changed = data ? ensureDailyReset() : false;
    if (changed || !stored) saveLocal();

    buildEventIndex();
    renderTabs();
    renderSelects();
    renderQuickNotes();
    renderAll();
    setWallButton(false);

    if (!readHash()) setView('pokemon', currentKid, { silent: true });

    bindEvents();
    startSync();

    var foot = $('#foot-updated');
    if (foot) {
      var bits = [];
      if (data && data.updated) bits.push('자료 ' + data.updated);
      bits.push('이 화면 ' + relTime(new Date(state._ts).toISOString()));
      foot.textContent = bits.join(' · ');
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start);
  } else {
    start();
  }
})();
