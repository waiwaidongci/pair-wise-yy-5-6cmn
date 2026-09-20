/* 状态规则模块：色号库存、画布状态，以及所有改动的唯一入口。
   规则：
   1. 色线按色号维护库存；任何着色（一笔填色 / 整笔替换）必须先对账，库存不足整次拒绝、不留半成品。
   2. 每次成功改动走同一个原子提交：更新画布 → 历史 → 预算作废重算 → 持久化，
      随后 UI 层用同一份新状态刷新画布、撤销重做、用色统计、重复预览与导出。
   3. 调整网格保留重叠区域；被裁图案保存为「最近版本」，恢复时旧预算强制作废并重算。 */
(function (root) {
  "use strict";

  var CATALOG = [
    { code: "W01", name: "米白", color: "#f7e7c4", seedStock: 200 },
    { code: "R02", name: "绛红", color: "#a6322d", seedStock: 32 },
    { code: "B03", name: "黛蓝", color: "#1f5f78", seedStock: 40 },
    { code: "Y04", name: "赭黄", color: "#d6a437", seedStock: 24 },
    { code: "G05", name: "松绿", color: "#355b38", seedStock: 32 },
    { code: "P06", name: "莲紫", color: "#713d7b", seedStock: 20 },
    { code: "K07", name: "玄黑", color: "#1e1b18", seedStock: 24 },
    { code: "O08", name: "橘橙", color: "#e98c52", seedStock: 16 }
  ];

  function createState(deps) {
    var storage = (deps && deps.storage) || root.T.createStorage();
    var history = root.T.createHistory(60);
    var budget = root.T.createBudget();

    var cols = 18, rows = 14;
    var cells = [];
    var stock = {};
    var savedAt = 0;
    var lastTrim = null; // 最近一次被裁掉的整版 {cols,rows,cells,at}
    var strokeStart = null, strokeCode = null, strokeStartCount = 0;

    function initialStock() {
      var s = {};
      CATALOG.forEach(function (c) { s[c.code] = c.seedStock; });
      return s;
    }

    function seedCells(c, r) {
      var a = new Array(c * r).fill(null);
      function diamond(cx, cy, code) {
        [[0, -1], [-1, 0], [0, 0], [1, 0], [0, 1]].forEach(function (p) {
          var x = cx + p[0], y = cy + p[1];
          if (x >= 0 && x < c && y >= 0 && y < r) a[y * c + x] = code;
        });
      }
      diamond(4, 4, "R02");
      diamond(12, 4, "B03");
      diamond(8, 9, "Y04");
      return a;
    }

    function countOf(arr, code) {
      var n = 0;
      for (var i = 0; i < arr.length; i++) if (arr[i] === code) n++;
      return n;
    }

    function isCode(code) {
      return CATALOG.some(function (c) { return c.code === code; });
    }

    function currentEntry(label) {
      return { label: label || "操作", at: Date.now(), cols: cols, rows: rows, cells: cells.slice() };
    }

    /* —— 唯一提交入口：所有成功改动都经过这里 —— */
    function commit(next, opts) {
      opts = opts || {};
      if (opts.record !== false) history.push(currentEntry(opts.label || "操作"));
      cols = next.cols; rows = next.rows; cells = next.cells.slice();
      if (next.stock) stock = Object.assign({}, next.stock);
      if (opts.invalidateBudget) budget.invalidate(); // 恢复裁剪版本：旧预算强制失效
      var result = budget.recompute(CATALOG, cells, stock);
      persist();
      return { ok: true, budget: result, label: opts.label || "" };
    }

    function persist() {
      savedAt = Date.now();
      storage.save(serialize());
    }

    function serialize() {
      return {
        version: 2,
        cols: cols, rows: rows,
        cells: cells,
        stock: stock,
        savedAt: savedAt,
        budgetRevision: budget.revision(),
        lastTrim: lastTrim,
        history: history.serialize()
      };
    }

    function hydrate(data) {
      cols = data.cols; rows = data.rows;
      cells = data.cells.map(function (v) { return isCode(v) ? v : null; });
      stock = initialStock();
      CATALOG.forEach(function (c) {
        if (typeof data.stock[c.code] === "number") stock[c.code] = Math.max(0, Math.floor(data.stock[c.code]));
      });
      savedAt = data.savedAt || 0;
      lastTrim = data.lastTrim && Array.isArray(data.lastTrim.cells) ? data.lastTrim : null;
      history.clear();
      if (data.history) history.hydrate(data.history);
      budget.setRevision(data.budgetRevision || 1);
      budget.prime(CATALOG, cells, stock, data.budgetRevision || 1);
    }

    /* —— 一笔拖动填色（开始 / 过程 / 结束） —— */
    function beginStroke(code) {
      if (!isCode(code)) return { ok: false, error: "未知色号" };
      strokeStart = cells.slice();
      strokeCode = code;
      strokeStartCount = countOf(strokeStart, code);
      return { ok: true };
    }

    function applyStroke(targets) {
      if (!strokeStart) return { ok: false, error: "尚未开始填色" };
      for (var i = 0; i < targets.length; i++) {
        var t = targets[i];
        if (t >= 0 && t < cells.length) cells[t] = strokeCode;
      }
      var added = 0;
      for (var j = 0; j < cells.length; j++) {
        if (cells[j] === strokeCode && strokeStart[j] !== strokeCode) added++;
      }
      var free = (stock[strokeCode] || 0) - strokeStartCount;
      if (added > free) {
        cells = strokeStart; // 库存不足：整笔回滚，画布上不留任何半成品
        strokeStart = null; strokeCode = null;
        return { ok: false, rejected: true, deficit: added - free,
                 error: "色号 " + strokeCode + " 库存不足（缺 " + (added - free) + " 格），本笔填色已整笔拒绝并还原" };
      }
      return { ok: true };
    }

    function endStroke(label) {
      if (!strokeStart) return { ok: false, rejected: true };
      var start = strokeStart;
      strokeStart = null; strokeCode = null;
      var same = start.length === cells.length;
      for (var i = 0; same && i < cells.length; i++) if (start[i] !== cells[i]) same = false;
      if (same) return { ok: true, noop: true };
      return commit({ cols: cols, rows: rows, cells: cells }, { label: label || "填色" });
    }

    function cancelStroke() {
      if (strokeStart) cells = strokeStart;
      strokeStart = null; strokeCode = null;
    }
    function isStroking() { return !!strokeStart; }

    /* —— 色号整笔替换：先全量对账，通过才一次性落盘；不足则拒绝，零修改 —— */
    function replaceColor(from, to) {
      if (!isCode(from) || !isCode(to)) return { ok: false, error: "未知色号" };
      if (from === to) return { ok: false, error: "源色号与目标色号相同" };
      var fromCount = countOf(cells, from);
      var toCount = countOf(cells, to);
      var finalTo = fromCount + toCount;
      var have = stock[to] || 0;
      if (finalTo > have) {
        return {
          ok: false, rejected: true,
          error: "色号 " + to + " 库存不足：需 " + finalTo + " 格，库存仅 " + have +
                 " 格，缺 " + (finalTo - have) + " 格。整次替换已拒绝，画布、历史、统计、预览、导出均不变。"
        };
      }
      if (fromCount === 0) return { ok: false, error: "画布上没有色号 " + from + "，无需替换" };
      var next = cells.map(function (v) { return v === from ? to : v; });
      var res = commit({ cols: cols, rows: rows, cells: next },
                       { label: "整笔替换 " + from + "→" + to });
      res.replaced = fromCount;
      res.from = from; res.to = to;
      return res;
    }

    /* —— 调整网格：保留重叠区域；裁掉非空格则留存「最近版本」 —— */
    function resize(nc, nr) {
      nc = Math.max(6, Math.min(36, Math.floor(Number(nc))));
      nr = Math.max(6, Math.min(32, Math.floor(Number(nr))));
      if (!(nc > 0) || !(nr > 0)) return { ok: false, error: "网格尺寸无效" };
      if (nc === cols && nr === rows) return { ok: true, noop: true };
      var next = new Array(nc * nr).fill(null);
      var cut = 0;
      for (var y = 0; y < rows; y++) {
        for (var x = 0; x < cols; x++) {
          var v = cells[y * cols + x];
          if (x < nc && y < nr) next[y * nc + x] = v;
          else if (v !== null) cut++;
        }
      }
      var prev = { cols: cols, rows: rows, cells: cells.slice(), at: Date.now() };
      var res = commit({ cols: nc, rows: nr, cells: next },
                       { label: "调整网格（保留重叠区域）" });
      if (cut > 0) lastTrim = prev; // 最近一次被裁版本，供一键恢复
      res.cut = cut;
      return res;
    }

    /* —— 从最近版本恢复：旧预算立即作废并重算 —— */
    function restoreTrim() {
      if (!lastTrim) return { ok: false, error: "没有可恢复的裁剪版本" };
      var prev = lastTrim;
      lastTrim = null;
      return commit(
        { cols: prev.cols, rows: prev.rows, cells: prev.cells.slice() },
        { label: "恢复最近裁剪版本", invalidateBudget: true }
      );
    }

    /* —— 库存维护：按色号直接改库存（不入撤销栈），预算随之重算 —— */
    function setStock(code, n) {
      if (!isCode(code)) return { ok: false, error: "未知色号" };
      n = Math.floor(Number(n));
      if (!(n >= 0)) return { ok: false, error: "库存必须是非负整数" };
      var next = Object.assign({}, stock);
      next[code] = n;
      return commit({ cols: cols, rows: rows, cells: cells, stock: next },
                    { record: false, label: "调整库存 " + code });
    }

    function undo() {
      var e = history.undo(currentEntry("重做"));
      if (!e) return { ok: false, error: "没有可撤销的操作" };
      cols = e.cols; rows = e.rows; cells = e.cells.slice();
      var result = budget.recompute(CATALOG, cells, stock);
      persist();
      return { ok: true, budget: result };
    }

    function redo() {
      var e = history.redo(currentEntry("撤销"));
      if (!e) return { ok: false, error: "没有可重做的操作" };
      cols = e.cols; rows = e.rows; cells = e.cells.slice();
      var result = budget.recompute(CATALOG, cells, stock);
      persist();
      return { ok: true, budget: result };
    }

    function save() {
      persist();
      return { ok: true, savedAt: savedAt };
    }

    /* 导出始终取自当前已提交状态 + 最新预算单，保证与画布/统计/预览一致 */
    function getExport() {
      var b = budget.recompute(CATALOG, cells, stock);
      return {
        meta: {
          tool: "手工织锦纹样排版台",
          generatedAt: new Date().toISOString(),
          budgetRevision: b.revision,
          emptyCode: null
        },
        cols: cols, rows: rows,
        cells: cells.slice(),
        stock: Object.assign({}, stock),
        budget: {
          revision: b.revision,
          totalNeed: b.totalNeed,
          totalStock: b.totalStock,
          filledCells: b.filledCells,
          emptyCells: b.emptyCells,
          short: b.short,
          shortCodes: b.shortCodes,
          shortageCells: b.shortageCells
        },
        usage: b.rows.map(function (r) {
          return { code: r.code, name: r.name, color: r.color,
                   count: r.need, stock: r.stock, free: r.free, over: r.over };
        })
      };
    }

    function view() {
      return {
        catalog: CATALOG,
        cols: cols, rows: rows, cells: cells,
        stock: stock,
        savedAt: savedAt,
        lastTrim: lastTrim,
        budget: budget.get() || budget.recompute(CATALOG, cells, stock),
        hist: { sizes: history.sizes(), meta: history.meta() }
      };
    }

    /* —— 初始化：新方案 / 已存方案 / 旧版迁移，三选一 —— */
    var loaded = storage.load();
    if (loaded && Array.isArray(loaded.cells)) {
      hydrate(loaded);
    } else {
      var legacy = storage.loadLegacy(CATALOG);
      stock = initialStock();
      if (legacy) {
        cols = legacy.cols; rows = legacy.rows; cells = legacy.cells;
        storage.clearLegacy();
      } else {
        cols = 18; rows = 14; cells = seedCells(cols, rows);
      }
      budget.prime(CATALOG, cells, stock, 1);
      persist();
    }

    return {
      catalog: CATALOG,
      view: view,
      beginStroke: beginStroke,
      applyStroke: applyStroke,
      endStroke: endStroke,
      cancelStroke: cancelStroke,
      isStroking: isStroking,
      replaceColor: replaceColor,
      resize: resize,
      restoreTrim: restoreTrim,
      setStock: setStock,
      undo: undo,
      redo: redo,
      save: save,
      getExport: getExport,
      persist: persist
    };
  }

  root.T = root.T || {};
  root.T.createState = createState;
})(typeof window !== "undefined" ? window : globalThis);
