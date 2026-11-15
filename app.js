/* =========================================================
   우리집 가족 대시보드 — app.js
   - 퀘스트 / XP / 레벨
   - 오늘 일정 & 준비물, 가족 캘린더, D-Day
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

  var STATE_ICON = {
    local: '💾 이 기기에 저장 중',
    syncing: '🔄 동기화하는 중…',
    synced: '✅ 동기화됨',
    error: '⚠️ 동기화 오류'
  };

  var WEEKDAYS = ['일요일', '월요일', '화요일', '수요일', '목요일', '금요일', '토요일'];
  var WEEKDAYS_SHORT = ['일', '월', '화', '수', '목', '금', '토'];

  var data = null;
  var state = null;
  var sync = { url: '', enabled: false };
  var calMonth = null;          // { y, m } (m: 0-11)
  var selectedDate = null;      // 'YYYY-MM-DD'
  var pollTimer = null;
  var pushTimer = null;
  var lastPayload = '';
  var clockTimer = null;
  var eventIndex = {};

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
    }, 2400);
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

  /* ---------------- 상태 정규화 ---------------- */
  function normalizeState(raw) {
    var s = (raw && typeof raw === 'object') ? raw : {};
    var out = {
      version: 1,
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

      out.kids[def.id] = {
        xp: Math.max(0, Number(cur.xp) || 0),
        resetDate: cur.resetDate ? String(cur.resetDate) : dateKey(),
        quests: quests
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

  function defaultState() { return normalizeState({ _ts: Date.now() }); }

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

  function questTotalXp(kid) {
    return kid.quests.reduce(function (sum, q) { return sum + (q.done ? q.xp : 0); }, 0);
  }

  /* =========================================================
     렌더링
     ========================================================= */
  function renderClock() {
    var now = new Date();
    var hour = now.getHours();
    var meridiem = hour < 12 ? '오전' : '오후';
    var hour12 = hour % 12 || 12;

    var clock = $('#clock');
    if (clock) clock.textContent = '지금은 ' + meridiem + ' ' + hour12 + ':' + pad(now.getMinutes());

    var dateEl = $('#today-date');
    if (dateEl) {
      dateEl.textContent = now.getFullYear() + '년 ' + (now.getMonth() + 1) + '월 ' + now.getDate() + '일 ' +
        WEEKDAYS[now.getDay()];
    }

    var sub = $('#today-date-sub');
    if (sub) {
      sub.textContent = (now.getMonth() + 1) + '월 ' + now.getDate() + '일 ' + WEEKDAYS[now.getDay()] + ' 기준';
    }
  }

  function renderWeather() {
    if (!data || !data.weather) return;
    var w = data.weather;

    var emoji = $('#weather-emoji');
    if (emoji) emoji.textContent = w.emoji || '🌤️';

    var place = $('#weather-place');
    if (place) place.textContent = w.place || '';

    var temp = $('#weather-temp');
    if (temp) temp.textContent = w.tempMin + '~' + w.tempMax + '°C';

    var summary = $('#weather-summary');
    if (summary) summary.textContent = w.summary || '';

    var outfit = $('#weather-outfit');
    if (outfit) outfit.textContent = w.outfit || '';

    var badge = $('#air-badge');
    if (badge && w.air) {
      badge.hidden = false;
      badge.dataset.level = w.air.level || 'moderate';
      badge.textContent = w.air.label + ' ' + w.air.pollutant + ' ' + w.air.value + ' ' + (w.air.advice || '');
    }
  }

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
          '<span class="quest__xp">+' + q.xp + ' XP</span>' +
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
        '<div class="quests">' + (quests || '<p class="empty">퀘스트를 추가해 보세요.</p>') + '</div>' +
        '<form class="quest-add" data-kid="' + esc(def.id) + '" autocomplete="off">' +
          '<input type="text" name="text" maxlength="40" placeholder="새 퀘스트 (예: 책 10쪽 읽기)" aria-label="새 퀘스트">' +
          '<input type="number" name="xp" min="1" max="100" step="5" value="10" aria-label="획득 XP">' +
          '<button type="submit" class="btn">+ 퀘스트 추가</button>' +
        '</form>' +
        '<div class="kid-card__foot">' +
          (allDone ? '<p class="kid-card__allclear">🎉 오늘 올클리어!</p>' : '<span></span>') +
          '<button type="button" class="btn btn--text" data-action="reset" data-kid="' + esc(def.id) + '">하루 초기화</button>' +
        '</div>' +
      '</article>';
  }

  function animateBars(root) {
    var bars = $$('.xp__bar', root || document);
    bars.forEach(function (bar) {
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
    var def = (data && data.kids || []).filter(function (k) { return k.id === kidId; })[0];
    var current = document.getElementById('card-' + kidId);
    if (!def || !current) return;
    current.outerHTML = kidCardHtml(def);
    var next = document.getElementById('card-' + kidId);
    animateBars(next);
    fixImages(next);
  }

  function renderToday() {
    var list = $('#today-list');
    if (!list) return;
    if (!data || !Array.isArray(data.today)) { list.innerHTML = ''; return; }

    list.innerHTML = data.today.map(function (item) {
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
  }

  /* ---------- 이벤트 인덱스 & D-Day ---------- */
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
    var list = $('#dday-list');
    if (!list) return;
    if (!data || !Array.isArray(data.dday)) { list.innerHTML = ''; return; }

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

    list.innerHTML = rows.map(function (row) {
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
  }

  /* ---------- 캘린더 ---------- */
  function renderCalendar() {
    var grid = $('#cal-grid');
    var label = $('#cal-month');
    if (!grid || !label) return;

    var y = calMonth.y;
    var m = calMonth.m;
    label.textContent = y + '년 ' + (m + 1) + '월';

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

    grid.innerHTML = html;
    renderDayDetail();
  }

  function renderDayDetail() {
    var box = $('#day-detail');
    if (!box) return;

    var key = selectedDate || dateKey();
    var d = parseKey(key);
    var events = eventIndex[key] || [];
    var todayK = dateKey();

    var head = '<p class="day-detail__date">' + (d.getMonth() + 1) + '월 ' + d.getDate() + '일 ' +
      WEEKDAYS[d.getDay()] + (key === todayK ? ' · 오늘' : '') + '</p>';

    if (!events.length) {
      box.innerHTML = head + '<p class="day-detail__empty">이 날은 등록된 일정이 없어요. 편안한 하루!</p>';
      return;
    }

    box.innerHTML = head + events.map(function (ev) {
      var prefix = ev.type === 'school' ? '🏫' : '🏠';
      return '' +
        '<p class="day-detail__item">' +
          '<span aria-hidden="true">' + esc(ev.emoji || prefix) + '</span>' +
          (ev.who ? '<span class="day-detail__who">' + esc(ev.who) + '</span>' : '') +
          '<strong>' + esc(ev.title) + '</strong>' +
          (ev.time ? '<span>' + esc(ev.time) + '</span>' : '') +
          (ev.detail ? '<span class="dday__note">' + esc(ev.detail) + '</span>' : '') +
        '</p>';
    }).join('');
  }

  /* ---------- 위시리스트 ---------- */
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

  /* ---------- 우체통 ---------- */
  function renderQuickNotes() {
    var box = $('#quick-notes');
    if (!box || !data) return;
    var items = Array.isArray(data.quickNotes) ? data.quickNotes : ['전화할게', '도와주세요'];
    box.innerHTML = items.map(function (text) {
      return '<button type="button" class="chip" data-quick="' + esc(text) + '">' + esc(text) + '</button>';
    }).join('');
  }

  function renderNotes() {
    var list = $('#notes');
    var empty = $('#note-empty');
    if (!list) return;

    if (!state.notes.length) {
      list.innerHTML = '';
      if (empty) empty.hidden = false;
      return;
    }
    if (empty) empty.hidden = true;

    var sorted = state.notes.slice().sort(function (a, b) {
      return new Date(b.createdAt) - new Date(a.createdAt);
    });

    list.innerHTML = sorted.map(function (n) {
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
  }

  function renderSelects() {
    var who = $('#wish-who');
    var from = $('#note-from');
    var options = (data && Array.isArray(data.wishlistWho)) ? data.wishlistWho : ['가족'];

    if (who && !who.options.length) {
      who.innerHTML = options.map(function (name) {
        return '<option value="' + esc(name) + '">' + esc(name) + '</option>';
      }).join('');
    }
    if (from && !from.options.length) {
      from.innerHTML = options.map(function (name) {
        return '<option value="' + esc(name) + '">' + esc(name) + '</option>';
      }).join('');
    }
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
    renderSyncChip(sync.enabled ? 'synced' : 'local');
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
    var afterLevel = levelOf(kid.xp);

    var def = data.kids.filter(function (k) { return k.id === kidId; })[0];
    var name = def ? def.name : '';

    touch();
    refreshKid(kidId);

    if (afterLevel > beforeLevel) {
      toast('🎉 ' + name + ' Lv.' + afterLevel + ' 달성!', 'level');
    } else if (checked) {
      var allDone = kid.quests.length > 0 && kid.quests.every(function (q) { return q.done; });
      if (allDone) toast('🏆 ' + name + ' 오늘 퀘스트 올클리어!', 'level');
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
    if (quest.done) kid.xp = Math.max(0, kid.xp - quest.xp);
    kid.quests = kid.quests.filter(function (q) { return q.id !== questId; });
    touch();
    refreshKid(kidId);
    toast('퀘스트를 지웠어요');
  }

  function resetKid(kidId) {
    var kid = state.kids[kidId];
    if (!kid) return;
    var hadDone = kid.quests.some(function (q) { return q.done; });
    if (!hadDone) { toast('이미 깨끗한 상태예요'); return; }
    kid.quests.forEach(function (q) { q.done = false; });
    kid.resetDate = dateKey();
    touch();
    refreshKid(kidId);
    toast('하루 퀘스트를 초기화했어요 (XP는 그대로)');
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
    var input = $('#sync-url');
    if (input) {
      input.value = sync.url;
      window.setTimeout(function () { input.focus(); }, 60);
    }
    setModalStatus(sync.enabled
      ? '연결됨 · 5초마다 다른 기기와 맞춰요. (' + sync.url + ')'
      : '아직 연결하지 않았어요. 비워두면 이 기기에만 저장됩니다.', sync.enabled ? 'ok' : '');
  }

  function closeModal(id) {
    var modal = document.getElementById(id);
    if (modal) modal.hidden = true;
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
  function bindEvents() {
    /* 아이들 퀘스트 */
    var grid = $('#kids-grid');
    if (grid) {
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

      /* 하루 초기화 직후에도 폼 입력이 사라지지 않도록: 입력 중인 값은 유지하지 않아도 무방 */
    }

    /* 캘린더 */
    var calGrid = $('#cal-grid');
    if (calGrid) {
      calGrid.addEventListener('click', function (e) {
        var btn = e.target.closest ? e.target.closest('.day') : null;
        if (!btn || btn.classList.contains('is-blank')) return;
        var key = btn.getAttribute('data-date');
        if (!key) return;
        selectedDate = key;
        $$('.day', calGrid).forEach(function (d) { d.classList.remove('is-selected'); });
        btn.classList.add('is-selected');
        renderDayDetail();
      });
    }

    var prev = $('#cal-prev');
    if (prev) {
      prev.addEventListener('click', function () {
        calMonth = calMonth.m === 0 ? { y: calMonth.y - 1, m: 11 } : { y: calMonth.y, m: calMonth.m - 1 };
        renderCalendar();
      });
    }

    var next = $('#cal-next');
    if (next) {
      next.addEventListener('click', function () {
        calMonth = calMonth.m === 11 ? { y: calMonth.y + 1, m: 0 } : { y: calMonth.y, m: calMonth.m + 1 };
        renderCalendar();
      });
    }

    /* 위시리스트 */
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

    /* 우체통 */
    var noteForm = $('#note-form');
    if (noteForm) {
      noteForm.addEventListener('submit', function (e) {
        e.preventDefault();
        var from = $('#note-from');
        var text = $('#note-text');
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

    var quick = $('#quick-notes');
    if (quick) {
      quick.addEventListener('click', function (e) {
        var chip = e.target.closest ? e.target.closest('[data-quick]') : null;
        if (!chip) return;
        var value = chip.getAttribute('data-quick');
        var from = $('#note-from');
        state.notes.push({
          id: uid(),
          from: from ? from.value : '',
          text: value,
          createdAt: new Date().toISOString()
        });
        touch();
        renderNotes();
        toast('보냈어요: ' + value);
      });
    }

    var notesList = $('#notes');
    if (notesList) {
      notesList.addEventListener('click', function (e) {
        var del = e.target.closest ? e.target.closest('[data-action="note-del"]') : null;
        if (!del) return;
        var row = del.closest('.note');
        if (!row) return;
        var id = row.getAttribute('data-id');
        state.notes = state.notes.filter(function (n) { return n.id !== id; });
        touch();
        renderNotes();
      });
    }

    /* 동기화 모달 */
    $$('[data-close]').forEach(function (el) {
      el.addEventListener('click', function () { closeModal(el.getAttribute('data-close')); });
    });

    var btnSync = $('#btn-sync');
    if (btnSync) btnSync.addEventListener('click', function () { openModal('sync-modal'); });

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

    /* 대기화면 */
    var btnFull = $('#btn-fullscreen');
    if (btnFull) btnFull.addEventListener('click', toggleWall);

    document.addEventListener('fullscreenchange', function () {
      if (!isFullscreen() && document.body.classList.contains('wall-mode') && !btnFull.__ignore) {
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

    var changed = data ? ensureDailyReset() : false;
    if (changed || !stored) saveLocal();

    buildEventIndex();
    renderSelects();
    renderQuickNotes();
    renderAll();
    setWallButton(false);

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
