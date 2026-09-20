/*
 * 状态规则模块
 * 职责：定义排版台文档状态（尺寸、格子、色号库存）与全部变更规则——
 * 落笔、色号整幅替换、保留重叠区域的尺寸调整、序列化与旧版存档迁移。
 * 所有 plan* 函数只校验不修改；apply* 函数返回新数组，绝不原地改动，
 * 配合历史记录模块保证任何操作要么整体生效、要么整体拒绝（不留半成品）。
 */
(function (global) {
  "use strict";

  const Budget = typeof module !== "undefined" && module.exports
    ? require("./budget.js")
    : global.BrocadeBudget;

  const COLORS = [
    { code: "01", name: "米白", hex: "#f7e7c4" },
    { code: "02", name: "朱红", hex: "#a6322d" },
    { code: "03", name: "靛蓝", hex: "#1f5f78" },
    { code: "04", name: "藤黄", hex: "#d6a437" },
    { code: "05", name: "松绿", hex: "#355b38" },
    { code: "06", name: "绛紫", hex: "#713d7b" },
    { code: "07", name: "墨黑", hex: "#1e1b18" },
    { code: "08", name: "橘橙", hex: "#e98c52" },
  ];

  const LIMITS = { minCols: 6, maxCols: 36, minRows: 6, maxRows: 32 };
  // 各色号默认库存（单位：格）。底色用量大，默认给足整幅上限。
  const DEFAULT_STOCK = [1152, 260, 260, 260, 260, 260, 260, 260];

  const STORAGE_KEY = "zfl31Studio.v1";
  const LEGACY_STORAGE_KEY = "zfl31Pattern";

  function createState(cols, rows) {
    const dims = clampDims(cols == null ? 18 : cols, rows == null ? 14 : rows);
    return {
      cols: dims.cols,
      rows: dims.rows,
      cells: Array(dims.cols * dims.rows).fill(0),
      stock: DEFAULT_STOCK.slice(),
      active: 1,
      block: "dot",
    };
  }

  function clampDims(cols, rows) {
    const c = Math.min(LIMITS.maxCols, Math.max(LIMITS.minCols, Math.round(Number(cols)) || LIMITS.minCols));
    const r = Math.min(LIMITS.maxRows, Math.max(LIMITS.minRows, Math.round(Number(rows)) || LIMITS.minRows));
    return { cols: c, rows: r };
  }

  function colorLabel(i) { return "色号" + COLORS[i].code; }

  // ---- 规则：单次落笔（纹样块盖章）。库存不足时整次拒绝。----
  function planPaint(state, targets, color) {
    const changed = [];
    const seen = new Set();
    for (const i of targets) {
      if (i < 0 || i >= state.cells.length || seen.has(i)) continue;
      seen.add(i);
      if (state.cells[i] !== color) changed.push(i);
    }
    if (changed.length === 0) return { ok: false, noop: true, reason: "没有需要改动的格子" };
    const remaining = state.stock[color] - Budget.usageOf(state.cells, state.stock.length)[color];
    if (changed.length > remaining) {
      return {
        ok: false,
        reason: colorLabel(color) + "库存不足：本次需要 " + changed.length + " 格，仅剩 " + Math.max(remaining, 0) + " 格，本次落笔已整次拒绝",
        need: changed.length,
        remaining,
      };
    }
    return { ok: true, changed };
  }

  function applyPaint(state, changed, color) {
    const cells = state.cells.slice();
    for (const i of changed) cells[i] = color;
    return cells;
  }

  // ---- 规则：色号整幅替换。必须先通过 planReplace 校验，否则不得调用 applyReplace。----
  function planReplace(state, from, to) {
    if (from === to) return { ok: false, reason: "源色号与目标色号相同，无需替换" };
    const usage = Budget.usageOf(state.cells, state.stock.length);
    const need = usage[from];
    if (need === 0) return { ok: false, reason: "画布上没有使用" + colorLabel(from) + "的格子" };
    const remaining = state.stock[to] - usage[to];
    if (remaining < need) {
      return {
        ok: false,
        reason: colorLabel(to) + "库存不足：替换需要 " + need + " 格，仅剩 " + Math.max(remaining, 0) + " 格，已整次拒绝",
        need,
        remaining,
      };
    }
    return { ok: true, need, remaining };
  }

  function applyReplace(state, from, to) {
    return state.cells.map(v => (v === from ? to : v));
  }

  // ---- 规则：调整网格尺寸，保留左上角对齐的重叠区域。----
  function planResize(state, nextCols, nextRows) {
    const dims = clampDims(nextCols, nextRows);
    const cells = Array(dims.cols * dims.rows).fill(0);
    const keepCols = Math.min(state.cols, dims.cols);
    const keepRows = Math.min(state.rows, dims.rows);
    for (let y = 0; y < keepRows; y++) {
      for (let x = 0; x < keepCols; x++) cells[y * dims.cols + x] = state.cells[y * state.cols + x];
    }
    let croppedPainted = 0;
    for (let y = 0; y < state.rows; y++) {
      for (let x = 0; x < state.cols; x++) {
        if ((x >= dims.cols || y >= dims.rows) && state.cells[y * state.cols + x] !== 0) croppedPainted++;
      }
    }
    return {
      cols: dims.cols,
      rows: dims.rows,
      cells,
      cropped: dims.cols < state.cols || dims.rows < state.rows,
      croppedPainted,
    };
  }

  // ---- 规则：纹样块落点（越界坐标裁掉）。----
  function stampTargets(state, index, block) {
    const x = index % state.cols;
    const y = Math.floor(index / state.cols);
    const offsets = block === "cross"
      ? [[0, 0], [-1, 0], [1, 0], [0, -1], [0, 1]]
      : block === "diamond"
        ? [[0, 0], [-1, 0], [1, 0], [0, -1], [0, 1], [-2, 0], [2, 0], [0, -2], [0, 2], [-1, -1], [1, -1], [-1, 1], [1, 1]]
        : [[0, 0]];
    const out = [];
    for (const [dx, dy] of offsets) {
      const nx = x + dx, ny = y + dy;
      if (nx >= 0 && nx < state.cols && ny >= 0 && ny < state.rows) out.push(ny * state.cols + nx);
    }
    return out;
  }

  // ---- 序列化：状态 + 历史整体持久化，刷新后一致；兼容旧版存档。----
  function serialize(state, historyJSON) {
    return JSON.stringify({
      version: 1,
      state: {
        cols: state.cols,
        rows: state.rows,
        cells: state.cells,
        stock: state.stock,
        active: state.active,
        block: state.block,
      },
      history: historyJSON || null,
    });
  }

  function deserialize(raw) {
    let data;
    try { data = JSON.parse(raw); } catch { return null; }
    if (!data || typeof data !== "object") return null;
    // 旧版存档仅含 { cols, rows, cells }
    const src = data.state && typeof data.state === "object" ? data.state : data;
    const dims = clampDims(src.cols, src.rows);
    const cells = Array.isArray(src.cells) ? src.cells.slice(0, dims.cols * dims.rows) : [];
    while (cells.length < dims.cols * dims.rows) cells.push(0);
    const norm = cells.map(v => (Number.isInteger(v) && v >= 0 && v < COLORS.length ? v : 0));
    const stock = Array.isArray(src.stock) && src.stock.length === COLORS.length
      ? src.stock.map(v => Math.max(0, Math.round(Number(v) || 0)))
      : DEFAULT_STOCK.slice();
    const active = Number.isInteger(src.active) && src.active >= 0 && src.active < COLORS.length ? src.active : 1;
    const block = ["dot", "cross", "diamond"].includes(src.block) ? src.block : "dot";
    return {
      state: { cols: dims.cols, rows: dims.rows, cells: norm, stock, active, block },
      history: data.history || null,
    };
  }

  const api = {
    COLORS, LIMITS, DEFAULT_STOCK, STORAGE_KEY, LEGACY_STORAGE_KEY,
    createState, clampDims,
    planPaint, applyPaint,
    planReplace, applyReplace,
    planResize, stampTargets,
    serialize, deserialize,
  };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  global.BrocadeState = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
