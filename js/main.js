/*
 * 主控模块
 * 职责：装配 状态规则 / 历史记录 / 渲染预算 三个独立模块，负责 UI 渲染、事件与持久化。
 * 所有变更走同一事务入口：先 plan 校验 → 记录历史 → 应用新状态 → 预算失效并重算 →
 * 持久化 → 整体重渲染（画布、用色统计、重复预览、预算面板、导出数据同源一致）。
 * 校验不过则直接返回，画布、历史、统计、预览、导出全部保持原样，不留半成品。
 */
(function () {
  "use strict";

  const State = window.BrocadeState;
  const Budget = window.BrocadeBudget;
  const { createHistory } = window.BrocadeHistory;
  const COLORS = State.COLORS;

  const $ = s => document.querySelector(s);
  const els = {
    cols: $("#cols"), rows: $("#rows"),
    resizeBtn: $("#resizeBtn"), newBtn: $("#newBtn"),
    palette: $("#palette"), grid: $("#grid"),
    replaceFrom: $("#replaceFrom"), replaceTo: $("#replaceTo"),
    replaceInfo: $("#replaceInfo"), replaceBtn: $("#replaceBtn"),
    undoBtn: $("#undoBtn"), redoBtn: $("#redoBtn"),
    stats: $("#stats"), budget: $("#budget"), preview: $("#preview"), risk: $("#risk"),
    versionBar: $("#versionBar"), versionInfo: $("#versionInfo"), restoreBtn: $("#restoreBtn"),
    saveBtn: $("#saveBtn"), exportBtn: $("#exportBtn"), toast: $("#toast"),
  };

  const history = createHistory();
  const budget = Budget.createBudget();
  let state = load() || State.createState();
  let dragging = false;

  // ---------- 持久化 ----------
  let persistTimer = null;
  function persist() {
    clearTimeout(persistTimer);
    persistTimer = setTimeout(persistNow, 120);
  }
  function persistNow() {
    clearTimeout(persistTimer);
    try { localStorage.setItem(State.STORAGE_KEY, State.serialize(state, history.toJSON())); } catch { /* 存储不可用时静默降级 */ }
  }
  function load() {
    try {
      const raw = localStorage.getItem(State.STORAGE_KEY) || localStorage.getItem(State.LEGACY_STORAGE_KEY);
      if (!raw) return null;
      const parsed = State.deserialize(raw);
      if (!parsed) return null;
      if (parsed.history) history.load(parsed.history);
      return parsed.state;
    } catch { return null; }
  }

  // ---------- 事务收尾：预算立即失效，同源重渲染 ----------
  function afterChange() {
    budget.invalidate();
    syncDimInputs();
    persist();
    renderAll();
  }

  // ---------- 操作（全部遵循 plan → commit → apply → afterChange）----------
  function doPaint(index) {
    const plan = State.planPaint(state, State.stampTargets(state, index, state.block), state.active);
    if (plan.noop) return;
    if (!plan.ok) { toast(plan.reason, true); return; }
    history.commit(state);
    state.cells = State.applyPaint(state, plan.changed, state.active);
    afterChange();
  }

  function doReplace(from, to) {
    const plan = State.planReplace(state, from, to);
    if (!plan.ok) { toast(plan.reason, true); return; } // 整次拒绝：不动画布 / 历史 / 统计 / 预览 / 导出
    history.commit(state);
    state.cells = State.applyReplace(state, from, to);
    afterChange();
    toast("已将" + label(from) + "整幅替换为" + label(to) + "，共 " + plan.need + " 格");
  }

  function doResize(nextCols, nextRows) {
    const plan = State.planResize(state, nextCols, nextRows);
    if (plan.cols === state.cols && plan.rows === state.rows) { toast("尺寸未变化"); return; }
    if (plan.cropped) history.saveVersion(state); // 裁掉前留存最近版本
    history.commit(state);
    state.cols = plan.cols; state.rows = plan.rows; state.cells = plan.cells;
    afterChange();
    if (plan.cropped && plan.croppedPainted > 0) toast("已裁掉 " + plan.croppedPainted + " 个填色格，可点击上方“恢复最近版本”找回");
    else if (plan.cropped) toast("网格已缩小，重叠区域已保留");
    else toast("网格已扩大，重叠区域已保留");
  }

  function doRestoreVersion() {
    const v = history.latestVersion();
    if (!v) return;
    history.commit(state);
    history.popVersion();
    state.cols = v.cols; state.rows = v.rows; state.cells = v.cells.slice();
    afterChange(); // afterChange 内 budget.invalidate()：旧预算立即失效并重算
    toast("已恢复最近版本，库存预算已重算");
  }

  function doUndo() {
    const s = history.undo(state);
    if (!s) return;
    state.cols = s.cols; state.rows = s.rows; state.cells = s.cells;
    afterChange();
  }
  function doRedo() {
    const s = history.redo(state);
    if (!s) return;
    state.cols = s.cols; state.rows = s.rows; state.cells = s.cells;
    afterChange();
  }

  function doNewBlank() {
    const dims = State.clampDims(Number(els.cols.value), Number(els.rows.value));
    history.commit(state);
    state.cols = dims.cols; state.rows = dims.rows;
    state.cells = Array(dims.cols * dims.rows).fill(0);
    afterChange();
    toast("已新建空白网格（可撤销）");
  }

  function doExport() {
    const snap = budget.current(state); // 与画布同源，导出即当前预算
    const data = {
      app: "brocade-studio",
      version: 1,
      exportedAt: new Date().toISOString(),
      cols: state.cols,
      rows: state.rows,
      cells: state.cells,
      palette: COLORS.map((c, i) => ({
        code: c.code, name: c.name, hex: c.hex,
        stock: state.stock[i], used: snap.used[i], remaining: snap.rows[i].remaining,
      })),
    };
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "brocade-pattern.json";
    a.click();
    URL.revokeObjectURL(a.href);
  }

  // ---------- 渲染 ----------
  function label(i) { return "色号" + COLORS[i].code; }

  function renderAll() {
    renderPalette();
    renderGrid();
    renderStats();
    renderPreview();
    renderRisk();
    renderBudgetPanel();
    renderReplaceInfo();
    renderHistoryButtons();
    renderVersionBar();
  }

  function renderPalette() {
    const snap = budget.current(state);
    els.palette.innerHTML = COLORS.map((c, i) =>
      '<button class="swatch ' + (i === state.active ? "active" : "") + '" data-color="' + i +
      '" style="background:' + c.hex + '" title="' + c.code + " " + c.name + " · 剩余 " + snap.rows[i].remaining + ' 格">' +
      '<span class="code">' + c.code + "</span></button>"
    ).join("");
    els.palette.querySelectorAll("[data-color]").forEach(el => {
      el.onclick = () => {
        state.active = Number(el.dataset.color);
        els.replaceFrom.value = String(state.active);
        persist();
        renderPalette();
        renderReplaceInfo();
      };
    });
  }

  function renderGrid() {
    els.grid.style.gridTemplateColumns = "repeat(" + state.cols + ", 1fr)";
    els.grid.innerHTML = state.cells.map((v, i) =>
      '<div class="cell" data-i="' + i + '" style="background:' + COLORS[v].hex + '"></div>'
    ).join("");
    els.grid.querySelectorAll(".cell").forEach(el => {
      el.onpointerdown = () => { dragging = true; doPaint(Number(el.dataset.i)); };
      el.onpointerenter = () => { if (dragging) doPaint(Number(el.dataset.i)); };
    });
  }

  function renderStats() {
    const snap = budget.current(state);
    els.stats.innerHTML = snap.rows.map(r => {
      const c = COLORS[r.index];
      return '<div class="stat"><span><span class="chip" style="background:' + c.hex + '"></span> ' +
        c.code + " " + c.name + "</span><b>" + r.used + "</b></div>";
    }).join("");
  }

  function renderPreview() {
    const N = 6;
    let html = "";
    for (let i = 0; i < N * N; i++) {
      const x = i % N, y = Math.floor(i / N);
      const v = state.cells[y * state.cols + x] || 0;
      html += '<div class="mini" style="background:' + COLORS[v].hex + '"></div>';
    }
    els.preview.innerHTML = html;
  }

  function renderRisk() {
    const riskRows = [];
    for (let y = 0; y < state.rows; y++) {
      let switches = 0;
      for (let x = 1; x < state.cols; x++) {
        if (state.cells[y * state.cols + x] !== state.cells[y * state.cols + x - 1]) switches++;
      }
      if (switches > state.cols * 0.62) riskRows.push(y + 1);
    }
    els.risk.innerHTML = riskRows.length
      ? '<p class="warning">第' + riskRows.join("、") + "行换色过密，可能断线。</p>"
      : "<p>暂无明显断线风险。</p>";
  }

  function renderBudgetPanel() {
    if (els.budget.contains(document.activeElement)) return; // 正在编辑库存输入框时不重绘
    Budget.renderBudget(els.budget, budget.current(state), COLORS, (i, v) => {
      state.stock[i] = v; // 库存是设置而非画布操作：不进撤销历史，但立即重算预算并持久化
      if (els.budget.contains(document.activeElement)) document.activeElement.blur(); // 放行预算面板重绘
      afterChange();
      toast(label(i) + "库存已调整为 " + v);
    });
  }

  function renderReplaceInfo() {
    const from = Number(els.replaceFrom.value), to = Number(els.replaceTo.value);
    const plan = State.planReplace(state, from, to); // 只读预检，实时提示可行性
    els.replaceInfo.className = "replace-info " + (plan.ok ? "ok" : "bad");
    els.replaceInfo.textContent = plan.ok
      ? "将替换 " + plan.need + " 格；" + label(to) + "剩余 " + plan.remaining + " 格，库存充足。"
      : plan.reason;
  }

  function renderHistoryButtons() {
    els.undoBtn.disabled = !history.canUndo();
    els.redoBtn.disabled = !history.canRedo();
  }

  function renderVersionBar() {
    const v = history.latestVersion();
    els.versionBar.hidden = !v;
    if (v) els.versionInfo.textContent = v.cols + "×" + v.rows + " · " + new Date(v.at).toLocaleTimeString();
  }

  // ---------- 提示 ----------
  let toastTimer = null;
  function toast(msg, isError) {
    els.toast.textContent = msg;
    els.toast.className = "show" + (isError ? " error" : "");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { els.toast.className = ""; }, 2800);
  }

  // ---------- 装配 ----------
  function syncDimInputs() {
    els.cols.value = state.cols;
    els.rows.value = state.rows;
  }

  function init() {
    const options = COLORS.map((c, i) => '<option value="' + i + '">' + c.code + " " + c.name + "</option>").join("");
    els.replaceFrom.innerHTML = options;
    els.replaceTo.innerHTML = options;
    els.replaceFrom.value = String(state.active);
    els.replaceTo.value = String(state.active === 0 ? 1 : 0);

    els.resizeBtn.onclick = () => doResize(Number(els.cols.value), Number(els.rows.value));
    els.newBtn.onclick = doNewBlank;
    els.undoBtn.onclick = doUndo;
    els.redoBtn.onclick = doRedo;
    els.replaceBtn.onclick = () => doReplace(Number(els.replaceFrom.value), Number(els.replaceTo.value));
    els.replaceFrom.onchange = renderReplaceInfo;
    els.replaceTo.onchange = renderReplaceInfo;
    els.restoreBtn.onclick = doRestoreVersion;
    els.saveBtn.onclick = () => { persistNow(); toast("方案已保存到本地"); };
    els.exportBtn.onclick = doExport;

    document.querySelectorAll("[data-block]").forEach(btn => {
      btn.onclick = () => {
        state.block = btn.dataset.block;
        document.querySelectorAll("[data-block]").forEach(b => b.classList.toggle("active", b === btn));
        persist();
      };
      btn.classList.toggle("active", btn.dataset.block === state.block);
    });

    window.onpointerup = () => { dragging = false; };
    window.addEventListener("keydown", e => {
      const mod = e.ctrlKey || e.metaKey;
      if (!mod) return;
      const k = e.key.toLowerCase();
      if (k === "z") { e.preventDefault(); e.shiftKey ? doRedo() : doUndo(); }
      else if (k === "y") { e.preventDefault(); doRedo(); }
    });

    syncDimInputs();
    renderAll();
  }

  init();
})();
