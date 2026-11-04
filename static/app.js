(() => {
  // Indexed by Date#getDay() (0=Sun … 6=Sat)
  const WEEKDAYS = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];
  const WEEKDAYS_SHORT = ["日", "一", "二", "三", "四", "五", "六"];
  // Column / mini-cal / month headers: Monday → Sunday
  const WEEK_HEADER_SHORT = ["一", "二", "三", "四", "五", "六", "日"];
  const DAY_START = 8;   // 08:00
  const DAY_END = 22;    // 22:00
  const HOURS = DAY_END - DAY_START;
  const HOUR_H = 56;
  const PERIOD_RANGES = {
    "上午": ["09:00", "12:00"],
    "下午": ["14:00", "18:00"],
    "晚上": ["19:00", "22:00"],
    "全天": null,
  };

  const api = window.worklog || null;

  const els = {
    calWrap: document.getElementById("calWrap"),
    rangeLabel: document.getElementById("rangeLabel"),
    miniTitle: document.getElementById("miniTitle"),
    miniGrid: document.getElementById("miniGrid"),
    btnPrev: document.getElementById("btnPrev"),
    btnNext: document.getElementById("btnNext"),
    btnToday: document.getElementById("btnToday"),
    btnExport: document.getElementById("btnExport"),
    btnExportSide: document.getElementById("btnExportSide"),
    miniPrev: document.getElementById("miniPrev"),
    miniNext: document.getElementById("miniNext"),
    popover: document.getElementById("popover"),
    popTime: document.getElementById("popTime"),
    popTitle: document.getElementById("popTitle"),
    popNote: document.getElementById("popNote"),
    popSave: document.getElementById("popSave"),
    popCancel: document.getElementById("popCancel"),
    popDelete: document.getElementById("popDelete"),
    toast: document.getElementById("toast"),
  };

  let view = "week"; // day | week | month
  let anchor = startOfDay(new Date()); // focused day
  let weekStart = mondayOf(anchor);
  let miniMonth = new Date(anchor.getFullYear(), anchor.getMonth(), 1);
  let entries = [];
  let nowTimer = null;

  // pointer interaction: create | resize | move
  let drag = null;
  // popover draft
  let draft = null; // { mode:'create'|'edit', id?, date, start, end, content, note, allDay }
  const MIN_DUR = 15; // minutes
  const SNAP = 15;

  function pad(n) { return String(n).padStart(2, "0"); }
  function toYMD(d) {
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  }
  function parseYMD(s) {
    const [y, m, d] = s.split("-").map(Number);
    return new Date(y, m - 1, d);
  }
  function startOfDay(d) {
    return new Date(d.getFullYear(), d.getMonth(), d.getDate());
  }
  function mondayOf(d) {
    const x = startOfDay(d);
    const day = (x.getDay() + 6) % 7; // Mon=0 … Sun=6
    x.setDate(x.getDate() - day);
    return x;
  }
  function addDays(d, n) {
    const x = startOfDay(d);
    x.setDate(x.getDate() + n);
    return x;
  }
  function sameDay(a, b) {
    return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
  }
  function toast(msg) {
    els.toast.textContent = msg;
    els.toast.classList.remove("hidden");
    clearTimeout(toast._t);
    toast._t = setTimeout(() => els.toast.classList.add("hidden"), 2200);
  }

  function minutesFromHHMM(s) {
    if (!s) return null;
    const [h, m] = s.split(":").map(Number);
    return h * 60 + m;
  }
  function hhmmFromMinutes(mins) {
    const h = Math.floor(mins / 60);
    const m = mins % 60;
    return `${pad(h)}:${pad(m)}`;
  }
  function clamp(n, a, b) { return Math.max(a, Math.min(b, n)); }

  /** Resolve display range for an entry. Returns {allDay, startMin, endMin, label} */
  function entryRange(e) {
    if (e.start_time && e.end_time) {
      let a = minutesFromHHMM(e.start_time);
      let b = minutesFromHHMM(e.end_time);
      if (b <= a) b = a + 30;
      return { allDay: false, startMin: a, endMin: b, label: `${e.start_time}–${e.end_time}` };
    }
    if (e.start_time) {
      const a = minutesFromHHMM(e.start_time);
      return { allDay: false, startMin: a, endMin: a + 60, label: `${e.start_time} 起` };
    }
    const p = e.period || "";
    if (p === "全天" || (!p && !e.start_time)) {
      return { allDay: true, startMin: 0, endMin: 24 * 60, label: p || "全天" };
    }
    if (PERIOD_RANGES[p]) {
      const r = PERIOD_RANGES[p];
      if (!r) return { allDay: true, startMin: 0, endMin: 24 * 60, label: p };
      return {
        allDay: false,
        startMin: minutesFromHHMM(r[0]),
        endMin: minutesFromHHMM(r[1]),
        label: p,
      };
    }
    // unknown period → treat as all-day chip
    return { allDay: true, startMin: 0, endMin: 24 * 60, label: p || "全天" };
  }

  function splitContent(raw) {
    const s = String(raw || "");
    const i = s.indexOf("\n");
    if (i < 0) return { title: s, note: "" };
    return { title: s.slice(0, i).trim(), note: s.slice(i + 1).trim() };
  }
  function joinContent(title, note) {
    const t = (title || "").trim();
    const n = (note || "").trim();
    return n ? `${t}\n${n}` : t;
  }

  async function httpApi(url, opts = {}) {
    const res = await fetch(url, {
      headers: { "Content-Type": "application/json", ...(opts.headers || {}) },
      ...opts,
    });
    if (!res.ok) {
      let msg = "请求失败";
      try { const j = await res.json(); msg = j.error || msg; } catch (_) {}
      throw new Error(msg);
    }
    if (res.status === 204) return null;
    return res.json();
  }

  async function loadEntries() {
    try {
      if (api) {
        // Ask for week containing anchor; for month we also need surrounding days —
        // list three weeks around the month by calling with month midpoints, then merge.
        if (view === "month") {
          const first = new Date(anchor.getFullYear(), anchor.getMonth(), 1);
          const last = new Date(anchor.getFullYear(), anchor.getMonth() + 1, 0);
          const weeks = [mondayOf(first), mondayOf(addDays(first, 14)), mondayOf(last)];
          const seen = new Set();
          const all = [];
          for (const w of weeks) {
            const data = await api.listEntries(toYMD(w));
            for (const e of data.entries || []) {
              if (!seen.has(e.id)) { seen.add(e.id); all.push(e); }
            }
          }
          entries = all;
        } else if (view === "day") {
          const data = await api.listEntries(toYMD(mondayOf(anchor)));
          entries = data.entries || [];
        } else {
          const data = await api.listEntries(toYMD(weekStart));
          entries = data.entries || [];
        }
      } else {
        const data = await httpApi(`/api/entries?week=${toYMD(weekStart)}`);
        entries = data.entries || [];
      }
    } catch (err) {
      toast(err.message || "加载失败");
      entries = [];
    }
  }

  function updateRangeLabel() {
    if (view === "week") {
      const end = addDays(weekStart, 6);
      const y = weekStart.getFullYear();
      els.rangeLabel.textContent =
        `${y}年${weekStart.getMonth() + 1}月${weekStart.getDate()}日 – ${end.getMonth() + 1}月${end.getDate()}日`;
    } else if (view === "day") {
      els.rangeLabel.textContent =
        `${anchor.getFullYear()}年${anchor.getMonth() + 1}月${anchor.getDate()}日 ${WEEKDAYS[anchor.getDay()]}`;
    } else {
      els.rangeLabel.textContent = `${anchor.getFullYear()}年${anchor.getMonth() + 1}月`;
    }
  }

  function renderMini() {
    const y = miniMonth.getFullYear();
    const m = miniMonth.getMonth();
    els.miniTitle.textContent = `${y}年${m + 1}月`;
    const first = new Date(y, m, 1);
    const start = mondayOf(first);
    const today = startOfDay(new Date());
    const selected = startOfDay(anchor);
    const cells = [];
    for (let i = 0; i < 42; i++) {
      const d = addDays(start, i);
      const muted = d.getMonth() !== m;
      const cls = [
        "mini-day",
        muted ? "muted" : "",
        sameDay(d, today) ? "today" : "",
        sameDay(d, selected) ? "selected" : "",
      ].filter(Boolean).join(" ");
      cells.push(`<button type="button" class="${cls}" data-ymd="${toYMD(d)}">${d.getDate()}</button>`);
    }
    els.miniGrid.innerHTML = cells.join("");
    els.miniGrid.querySelectorAll(".mini-day").forEach((btn) => {
      btn.addEventListener("click", () => {
        anchor = parseYMD(btn.dataset.ymd);
        weekStart = mondayOf(anchor);
        miniMonth = new Date(anchor.getFullYear(), anchor.getMonth(), 1);
        refresh();
      });
    });
  }

  function entriesForDate(ymd) {
    return entries.filter((e) => e.date === ymd);
  }

  function yOffset(minOfDay) {
    return ((minOfDay - DAY_START * 60) / 60) * HOUR_H;
  }

  function minFromClientY(colEl, clientY, snap = SNAP) {
    const top = colEl.getBoundingClientRect().top;
    const rel = clientY - top;
    const rawMin = DAY_START * 60 + (rel / HOUR_H) * 60;
    const snapped = Math.round(rawMin / snap) * snap;
    return clamp(snapped, DAY_START * 60, DAY_END * 60);
  }

  function colFromPoint(clientX, clientY) {
    const elsAt = document.elementsFromPoint(clientX, clientY);
    for (const node of elsAt) {
      if (node.classList && node.classList.contains("tv-col")) return node;
      const col = node.closest && node.closest(".tv-col");
      if (col) return col;
    }
    return null;
  }

  function applyBlockGeometry(el, startMin, endMin) {
    const top = yOffset(startMin);
    const bottom = yOffset(endMin);
    el.style.top = `${top}px`;
    el.style.height = `${Math.max(18, bottom - top)}px`;
    const label = `${hhmmFromMinutes(startMin)}–${hhmmFromMinutes(endMin)}`;
    const es = el.querySelector(".es");
    if (es) es.textContent = label;
  }

  async function persistEntryTimes(entry, date, startMin, endMin) {
    const payload = {
      date,
      content: entry.content,
      start_time: hhmmFromMinutes(startMin),
      end_time: hhmmFromMinutes(endMin),
      period: null,
    };
    try {
      if (api) await api.updateEntry(entry.id, payload);
      else await httpApi(`/api/entries/${entry.id}`, { method: "PUT", body: JSON.stringify(payload) });
      // patch local cache
      const idx = entries.findIndex((e) => e.id === entry.id);
      if (idx >= 0) {
        entries[idx] = { ...entries[idx], ...payload, updated_at: entries[idx].updated_at };
      }
      toast("已调整时间");
      await refresh();
    } catch (err) {
      toast(err.message || "调整失败");
      await refresh();
    }
  }

  function renderTimeView(dates) {
    const cols = dates.length;
    const today = startOfDay(new Date());
    const head = dates.map((d, i) => {
      const isToday = sameDay(d, today);
      // 周视图：周一=1 … 周日=7；日视图仍用公历日号
      const num = cols === 7 ? i + 1 : d.getDate();
      return `<div class="tv-dow${isToday ? " today" : ""}">
        <div class="wd">${WEEKDAYS_SHORT[d.getDay()]}</div>
        <div class="dn">${num}</div>
      </div>`;
    }).join("");

    const alldaySlots = dates.map((d) => {
      const ymd = toYMD(d);
      const chips = entriesForDate(ymd)
        .filter((e) => entryRange(e).allDay)
        .map((e) => {
          const { title } = splitContent(e.content);
          return `<div class="allday-chip" data-id="${e.id}" title="${escapeAttr(e.content)}">${escapeHtml(title || "(无标题)")}</div>`;
        }).join("");
      return `<div class="slot" data-ymd="${ymd}">${chips}</div>`;
    }).join("");

    const ticks = [];
    for (let h = DAY_START; h < DAY_END; h++) {
      ticks.push(`<div class="tick"><span>${pad(h)}:00</span></div>`);
    }

    const colHtml = dates.map((d) => {
      const ymd = toYMD(d);
      const isToday = sameDay(d, today);
      return `<div class="tv-col${isToday ? " today" : ""}" data-ymd="${ymd}" style="height:${HOURS * HOUR_H}px"></div>`;
    }).join("");

    els.calWrap.innerHTML = `
      <div class="time-view" style="--cols:${cols}; --hours:${HOURS}; --hour-h:${HOUR_H}px">
        <div class="tv-head">
          <div class="corner"></div>
          ${head}
        </div>
        <div class="tv-allday">
          <div class="label">全天</div>
          ${alldaySlots}
        </div>
        <div class="tv-body" id="tvBody">
          <div class="tv-grid" id="tvGrid">
            <div class="tv-times">${ticks.join("")}</div>
            ${colHtml}
          </div>
        </div>
      </div>`;

    const body = document.getElementById("tvBody");
    const grid = document.getElementById("tvGrid");

    // place timed events
    dates.forEach((d) => {
      const ymd = toYMD(d);
      const col = grid.querySelector(`.tv-col[data-ymd="${ymd}"]`);
      if (!col) return;
      const dayEntries = entriesForDate(ymd).filter((e) => !entryRange(e).allDay);
      const laid = layoutOverlaps(dayEntries);
      for (const { entry, colIndex, colCount } of laid) {
        const r = entryRange(entry);
        let top = yOffset(r.startMin);
        let bottom = yOffset(r.endMin);
        if (bottom <= top) bottom = top + 20;
        if (bottom < 0 || top > HOURS * HOUR_H) continue;
        top = clamp(top, 0, HOURS * HOUR_H);
        bottom = clamp(bottom, 0, HOURS * HOUR_H);
        const { title } = splitContent(entry.content);
        const widthPct = 100 / colCount;
        const leftPct = colIndex * widthPct;
        const el = document.createElement("div");
        el.className = "event-block";
        el.dataset.id = entry.id;
        el.style.top = `${top}px`;
        el.style.height = `${Math.max(18, bottom - top)}px`;
        el.style.left = `calc(${leftPct}% + 2px)`;
        el.style.right = `auto`;
        el.style.width = `calc(${widthPct}% - 4px)`;
        el.innerHTML = `
          <div class="resize-handle resize-n" data-edge="start" title="拖动调整开始时间"></div>
          <div class="et">${escapeHtml(title || "(无标题)")}</div>
          <div class="es">${escapeHtml(r.label)}</div>
          <div class="resize-handle resize-s" data-edge="end" title="拖动调整结束时间"></div>`;

        el.addEventListener("mousedown", (ev) => {
          if (ev.button !== 0) return;
          ev.stopPropagation(); // don't start create-drag on the column
          const handle = ev.target.closest(".resize-handle");
          const range = entryRange(entry);
          const colEl = el.closest(".tv-col");
          if (handle) {
            ev.preventDefault();
            drag = {
              type: "resize",
              edge: handle.dataset.edge, // start | end
              entry,
              el,
              colEl,
              date: colEl.dataset.ymd,
              startMin: range.startMin,
              endMin: range.endMin,
              moved: false,
            };
            el.classList.add("resizing");
            document.body.classList.add("wl-resizing");
            return;
          }
          // body: prepare move (threshold decides move vs click-edit)
          // Do NOT preventDefault here — otherwise click-to-edit is suppressed.
          drag = {
            type: "move-pending",
            entry,
            el,
            colEl,
            date: colEl.dataset.ymd,
            startMin: range.startMin,
            endMin: range.endMin,
            duration: range.endMin - range.startMin,
            originY: ev.clientY,
            originX: ev.clientX,
            offsetMin: minFromClientY(colEl, ev.clientY, 1) - range.startMin,
            moved: false,
          };
        });

        el.addEventListener("click", (ev) => {
          ev.stopPropagation();
          // After resize/move, a capturing handler suppresses this click.
          if (drag && drag.moved) return;
          openEdit(entry);
        });

        col.appendChild(el);
      }
    });

    // all-day chip clicks
    els.calWrap.querySelectorAll(".allday-chip").forEach((chip) => {
      chip.addEventListener("click", (ev) => {
        ev.stopPropagation();
        const entry = entries.find((e) => e.id === chip.dataset.id);
        if (entry) openEdit(entry);
      });
    });

    // drag-to-create on empty column space
    grid.querySelectorAll(".tv-col").forEach((col) => {
      col.addEventListener("mousedown", (ev) => {
        if (ev.button !== 0) return;
        if (ev.target.closest(".event-block")) return;
        const ymd = col.dataset.ymd;
        const startMin = minFromClientY(col, ev.clientY);
        const ghost = document.createElement("div");
        ghost.className = "ghost";
        col.appendChild(ghost);
        drag = {
          type: "create",
          colEl: col,
          date: ymd,
          startMin,
          endMin: startMin + 30,
          ghost,
          moved: true,
        };
        updateCreateGhost();
        ev.preventDefault();
      });
    });

    function updateCreateGhost() {
      if (!drag || drag.type !== "create") return;
      const a = Math.min(drag.startMin, drag.endMin);
      const b = Math.max(drag.startMin, drag.endMin);
      drag.ghost.style.top = `${yOffset(a)}px`;
      drag.ghost.style.height = `${Math.max(8, yOffset(b) - yOffset(a))}px`;
    }

    function onMove(ev) {
      if (!drag) return;

      if (drag.type === "create") {
        const end = minFromClientY(drag.colEl, ev.clientY);
        drag.endMin = end === drag.startMin ? drag.startMin + MIN_DUR : end;
        updateCreateGhost();
        return;
      }

      if (drag.type === "move-pending") {
        const dist = Math.hypot(ev.clientX - drag.originX, ev.clientY - drag.originY);
        if (dist < 4) return;
        drag.type = "move";
        drag.moved = true;
        drag.el.classList.add("moving");
        document.body.classList.add("wl-moving");
      }

      if (drag.type === "resize") {
        drag.moved = true;
        const mins = minFromClientY(drag.colEl, ev.clientY);
        if (drag.edge === "start") {
          drag.startMin = clamp(mins, DAY_START * 60, drag.endMin - MIN_DUR);
        } else {
          drag.endMin = clamp(mins, drag.startMin + MIN_DUR, DAY_END * 60);
        }
        applyBlockGeometry(drag.el, drag.startMin, drag.endMin);
        return;
      }

      if (drag.type === "move") {
        drag.moved = true;
        const overCol = colFromPoint(ev.clientX, ev.clientY) || drag.colEl;
        const pointerMin = minFromClientY(overCol, ev.clientY, 1);
        let newStart = Math.round((pointerMin - drag.offsetMin) / SNAP) * SNAP;
        newStart = clamp(newStart, DAY_START * 60, DAY_END * 60 - drag.duration);
        let newEnd = newStart + drag.duration;
        if (newEnd > DAY_END * 60) {
          newEnd = DAY_END * 60;
          newStart = newEnd - drag.duration;
        }
        drag.startMin = newStart;
        drag.endMin = newEnd;
        drag.date = overCol.dataset.ymd;
        // visually move across columns if needed
        if (overCol !== drag.el.parentElement) {
          overCol.appendChild(drag.el);
          drag.colEl = overCol;
          // full width while dragging for clarity
          drag.el.style.left = "2px";
          drag.el.style.width = "calc(100% - 4px)";
        }
        applyBlockGeometry(drag.el, drag.startMin, drag.endMin);
      }
    }

    async function onUp(ev) {
      if (!drag) return;
      const current = drag;
      drag = null;
      document.body.classList.remove("wl-resizing", "wl-moving");

      if (current.type === "create") {
        const a = Math.min(current.startMin, current.endMin);
        let b = Math.max(current.startMin, current.endMin);
        if (b - a < MIN_DUR) b = a + 30;
        if (current.ghost && current.ghost.parentNode) current.ghost.remove();
        openCreate(current.date, hhmmFromMinutes(a), hhmmFromMinutes(Math.min(b, DAY_END * 60)));
        return;
      }

      if (current.type === "move-pending") {
        // treated as click — openEdit handled by click handler
        current.el.classList.remove("moving", "resizing");
        return;
      }

      if (current.type === "resize" || current.type === "move") {
        current.el.classList.remove("moving", "resizing");
        if (!current.moved) return;
        // suppress the click that follows mouseup
        current.el.addEventListener("click", function stop(e) {
          e.stopPropagation();
          e.preventDefault();
          current.el.removeEventListener("click", stop, true);
        }, true);
        await persistEntryTimes(current.entry, current.date, current.startMin, current.endMin);
      }
    }

    window.__wlMove && window.removeEventListener("mousemove", window.__wlMove);
    window.__wlUp && window.removeEventListener("mouseup", window.__wlUp);
    window.__wlMove = onMove;
    window.__wlUp = onUp;
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);

    // now line
    placeNowLine(grid, dates);
    clearInterval(nowTimer);
    nowTimer = setInterval(() => placeNowLine(grid, dates), 60000);

    // scroll to ~ now or 9:00
    const now = new Date();
    const focusMin = (now.getHours() >= DAY_START && now.getHours() < DAY_END)
      ? now.getHours() * 60 + now.getMinutes() - 60
      : 9 * 60;
    body.scrollTop = Math.max(0, yOffset(focusMin));
  }

  function placeNowLine(grid, dates) {
    grid.querySelectorAll(".now-line").forEach((n) => n.remove());
    const now = new Date();
    const mins = now.getHours() * 60 + now.getMinutes();
    if (mins < DAY_START * 60 || mins > DAY_END * 60) return;
    dates.forEach((d) => {
      if (!sameDay(d, startOfDay(now))) return;
      const col = grid.querySelector(`.tv-col[data-ymd="${toYMD(d)}"]`);
      if (!col) return;
      const line = document.createElement("div");
      line.className = "now-line";
      line.style.top = `${yOffset(mins)}px`;
      col.appendChild(line);
    });
  }

  function layoutOverlaps(dayEntries) {
    // greedy column packing
    const items = dayEntries.map((entry) => {
      const r = entryRange(entry);
      return { entry, start: r.startMin, end: r.endMin, colIndex: 0, colCount: 1 };
    }).sort((a, b) => a.start - b.start || a.end - b.end);

    const colEnds = [];
    for (const it of items) {
      let placed = false;
      for (let c = 0; c < colEnds.length; c++) {
        if (colEnds[c] <= it.start) {
          it.colIndex = c;
          colEnds[c] = it.end;
          placed = true;
          break;
        }
      }
      if (!placed) {
        it.colIndex = colEnds.length;
        colEnds.push(it.end);
      }
    }
    // group overlapping clusters to set colCount
    // simplify: use max columns overall for overlapping set
    for (let i = 0; i < items.length; i++) {
      let maxCol = items[i].colIndex;
      for (let j = 0; j < items.length; j++) {
        if (i === j) continue;
        if (items[i].start < items[j].end && items[j].start < items[i].end) {
          maxCol = Math.max(maxCol, items[j].colIndex);
        }
      }
      items[i].colCount = maxCol + 1;
    }
    return items;
  }

  function renderMonth() {
    const y = anchor.getFullYear();
    const m = anchor.getMonth();
    const first = new Date(y, m, 1);
    const start = mondayOf(first);
    const today = startOfDay(new Date());
    const dows = WEEK_HEADER_SHORT.map((w) => `<div class="month-dow">${w}</div>`).join("");
    const cells = [];
    for (let i = 0; i < 42; i++) {
      const d = addDays(start, i);
      const ymd = toYMD(d);
      const muted = d.getMonth() !== m;
      const isToday = sameDay(d, today);
      const list = entriesForDate(ymd).slice(0, 4).map((e) => {
        const { title } = splitContent(e.content);
        return `<div class="month-ev" data-id="${e.id}">${escapeHtml(title || "(无标题)")}</div>`;
      }).join("");
      cells.push(`<div class="month-cell${muted ? " muted" : ""}${isToday ? " today" : ""}" data-ymd="${ymd}">
        <div class="md">${d.getDate()}</div>${list}
      </div>`);
    }
    els.calWrap.innerHTML = `<div class="month-view"><div class="month-grid">${dows}${cells.join("")}</div></div>`;
    els.calWrap.querySelectorAll(".month-cell").forEach((cell) => {
      cell.addEventListener("click", (ev) => {
        if (ev.target.closest(".month-ev")) return;
        // switch to day view for that date, or quick-create all-day
        anchor = parseYMD(cell.dataset.ymd);
        weekStart = mondayOf(anchor);
        setView("day");
      });
      cell.addEventListener("dblclick", (ev) => {
        ev.preventDefault();
        openCreate(cell.dataset.ymd, "09:00", "10:00");
      });
    });
    els.calWrap.querySelectorAll(".month-ev").forEach((evEl) => {
      evEl.addEventListener("click", (ev) => {
        ev.stopPropagation();
        const entry = entries.find((e) => e.id === evEl.dataset.id);
        if (entry) openEdit(entry);
      });
    });
  }

  function escapeHtml(s) {
    return String(s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }
  function escapeAttr(s) {
    return escapeHtml(s).replace(/\n/g, " ");
  }

  function openCreate(date, start, end) {
    draft = { mode: "create", id: null, date, start, end, allDay: false };
    els.popTime.textContent = `${date}  ${start} – ${end}`;
    els.popTitle.value = "";
    els.popNote.value = "";
    els.popDelete.classList.add("hidden");
    els.popover.classList.remove("hidden");
    setTimeout(() => els.popTitle.focus(), 30);
  }

  function openEdit(entry) {
    const r = entryRange(entry);
    const { title, note } = splitContent(entry.content);
    draft = {
      mode: "edit",
      id: entry.id,
      date: entry.date,
      start: r.allDay ? null : hhmmFromMinutes(r.startMin),
      end: r.allDay ? null : hhmmFromMinutes(r.endMin),
      allDay: r.allDay,
      period: entry.period || null,
    };
    els.popTime.textContent = r.allDay
      ? `${entry.date}  ${r.label}`
      : `${entry.date}  ${hhmmFromMinutes(r.startMin)} – ${hhmmFromMinutes(r.endMin)}`;
    els.popTitle.value = title;
    els.popNote.value = note;
    els.popDelete.classList.remove("hidden");
    els.popover.classList.remove("hidden");
    setTimeout(() => els.popTitle.focus(), 30);
  }

  function closePop() {
    els.popover.classList.add("hidden");
    draft = null;
  }

  async function saveDraft() {
    if (!draft) return;
    const title = els.popTitle.value.trim();
    if (!title) { toast("请填写内容"); els.popTitle.focus(); return; }
    const content = joinContent(title, els.popNote.value);
    const payload = {
      date: draft.date,
      content,
      start_time: draft.allDay ? null : draft.start,
      end_time: draft.allDay ? null : draft.end,
      period: draft.allDay ? (draft.period || "全天") : null,
    };
    try {
      if (api) {
        if (draft.mode === "edit") await api.updateEntry(draft.id, payload);
        else await api.createEntry(payload);
      } else if (draft.mode === "edit") {
        await httpApi(`/api/entries/${draft.id}`, { method: "PUT", body: JSON.stringify(payload) });
      } else {
        await httpApi("/api/entries", { method: "POST", body: JSON.stringify(payload) });
      }
      toast(draft.mode === "edit" ? "已更新" : "已添加");
      closePop();
      await refresh();
    } catch (err) {
      toast(err.message || "保存失败");
    }
  }

  async function deleteDraft() {
    // Snapshot id first: Electron's dialog pumps the event loop; a click-through
    // on the modal backdrop can call closePop() and null `draft` mid-flight.
    if (!draft || !draft.id) return;
    const id = draft.id;
    let ok = false;
    try {
      if (api && typeof api.confirmDelete === "function") {
        ok = await api.confirmDelete("确定删除这条记录？");
      } else {
        ok = window.confirm("确定删除这条记录？");
      }
    } catch (_) {
      ok = window.confirm("确定删除这条记录？");
    }
    if (!ok) return;
    try {
      if (api) await api.deleteEntry(id);
      else await httpApi(`/api/entries/${id}`, { method: "DELETE" });
      toast("已删除");
      closePop();
      await refresh();
    } catch (err) {
      toast(err.message || "删除失败");
    }
  }

  async function exportWeek() {
    try {
      if (api) {
        const result = await api.exportWeek(toYMD(weekStart));
        if (result.canceled) { toast("已取消导出"); return; }
        toast("已导出 Markdown");
        return;
      }
      const res = await fetch(`/api/export?week=${toYMD(weekStart)}`);
      if (!res.ok) throw new Error("导出失败");
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `week-worklog-${toYMD(weekStart)}.md`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
      toast("已导出 Markdown");
    } catch (err) {
      toast(err.message || "导出失败");
    }
  }

  function setView(v) {
    view = v;
    document.querySelectorAll(".seg-btn").forEach((b) => {
      b.classList.toggle("active", b.dataset.view === view);
    });
    refresh();
  }

  async function refresh() {
    weekStart = mondayOf(anchor);
    updateRangeLabel();
    renderMini();
    await loadEntries();
    if (view === "month") renderMonth();
    else if (view === "day") renderTimeView([startOfDay(anchor)]);
    else renderTimeView(Array.from({ length: 7 }, (_, i) => addDays(weekStart, i)));
  }

  // events
  els.btnPrev.addEventListener("click", () => {
    if (view === "month") {
      anchor = new Date(anchor.getFullYear(), anchor.getMonth() - 1, 1);
      miniMonth = new Date(anchor.getFullYear(), anchor.getMonth(), 1);
    } else if (view === "day") {
      anchor = addDays(anchor, -1);
      miniMonth = new Date(anchor.getFullYear(), anchor.getMonth(), 1);
    } else {
      anchor = addDays(weekStart, -7);
      weekStart = mondayOf(anchor);
      miniMonth = new Date(anchor.getFullYear(), anchor.getMonth(), 1);
    }
    refresh();
  });
  els.btnNext.addEventListener("click", () => {
    if (view === "month") {
      anchor = new Date(anchor.getFullYear(), anchor.getMonth() + 1, 1);
      miniMonth = new Date(anchor.getFullYear(), anchor.getMonth(), 1);
    } else if (view === "day") {
      anchor = addDays(anchor, 1);
      miniMonth = new Date(anchor.getFullYear(), anchor.getMonth(), 1);
    } else {
      anchor = addDays(weekStart, 7);
      weekStart = mondayOf(anchor);
      miniMonth = new Date(anchor.getFullYear(), anchor.getMonth(), 1);
    }
    refresh();
  });
  els.btnToday.addEventListener("click", () => {
    anchor = startOfDay(new Date());
    weekStart = mondayOf(anchor);
    miniMonth = new Date(anchor.getFullYear(), anchor.getMonth(), 1);
    refresh();
  });
  els.miniPrev.addEventListener("click", () => {
    miniMonth = new Date(miniMonth.getFullYear(), miniMonth.getMonth() - 1, 1);
    renderMini();
  });
  els.miniNext.addEventListener("click", () => {
    miniMonth = new Date(miniMonth.getFullYear(), miniMonth.getMonth() + 1, 1);
    renderMini();
  });
  document.querySelectorAll(".seg-btn").forEach((b) => {
    b.addEventListener("click", () => setView(b.dataset.view));
  });
  els.btnExport.addEventListener("click", exportWeek);
  els.btnExportSide.addEventListener("click", exportWeek);
  els.popCancel.addEventListener("click", closePop);
  els.popSave.addEventListener("click", saveDraft);
  els.popDelete.addEventListener("click", deleteDraft);
  els.popover.addEventListener("click", (ev) => {
    // Only close when clicking the dimmed backdrop itself (not the card).
    // Use click (not mousedown) so native/IPC confirm dialogs are less likely
    // to click-through and wipe `draft` while a delete is in progress.
    if (ev.target === els.popover) closePop();
  });
  els.popTitle.addEventListener("keydown", (ev) => {
    if (ev.key === "Enter") { ev.preventDefault(); saveDraft(); }
    if (ev.key === "Escape") closePop();
  });
  document.addEventListener("keydown", (ev) => {
    if (els.popover.classList.contains("hidden")) return;
    if (ev.key === "Escape") {
      closePop();
      return;
    }
    if ((ev.key === "Delete" || ev.key === "Backspace") && draft && draft.mode === "edit" && draft.id) {
      const tag = (ev.target && ev.target.tagName) || "";
      if (tag === "INPUT" || tag === "TEXTAREA") return; // typing in fields
      ev.preventDefault();
      deleteDraft();
    }
  });

  if (api && api.onMenuExport) api.onMenuExport(() => exportWeek());

  document.documentElement.style.setProperty("--hour-h", `${HOUR_H}px`);
  refresh().catch((err) => toast(err.message || "加载失败"));
})();
