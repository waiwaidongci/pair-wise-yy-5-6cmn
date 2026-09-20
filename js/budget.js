/* 渲染预算模块：按色号把画布需求（格数）与库存（可染色格数）对账。
   - 预算单带版本号 revision；画布/网格/库存任一变化即作废旧结果并按新签名重算。
   - 模块自身不修改任何数据，只做核算，供画布、统计、预览、导出共用同一份结果。 */
(function (root) {
  "use strict";

  function createBudget() {
    var revision = 0;
    var cache = null; // { sig, result }

    function signature(cells, stock) {
      var s = "";
      for (var i = 0; i < cells.length; i++) s += cells[i] + ".";
      var codes = Object.keys(stock).sort();
      for (var k = 0; k < codes.length; k++) s += codes[k] + ":" + stock[codes[k]] + ";";
      return s;
    }

    function evaluate(catalog, cells, stock) {
      var rows = catalog.map(function (c) {
        var need = 0;
        for (var i = 0; i < cells.length; i++) if (cells[i] === c.code) need++;
        var have = stock[c.code] || 0;
        return {
          code: c.code,
          name: c.name,
          color: c.color,
          need: need,
          stock: have,
          free: have - need,
          over: need > have
        };
      });
      var totalNeed = 0, totalStock = 0, shortageCells = 0;
      var shortCodes = [];
      rows.forEach(function (r) {
        totalNeed += r.need;
        totalStock += r.stock;
        if (r.over) { shortageCells += r.need - r.stock; shortCodes.push(r.code); }
      });
      return {
        revision: revision,
        rows: rows,
        totalNeed: totalNeed,
        totalStock: totalStock,
        filledCells: totalNeed,
        emptyCells: cells.length - totalNeed,
        short: shortCodes.length > 0,
        shortCodes: shortCodes,
        shortageCells: shortageCells
      };
    }

    return {
      /* 任何一次提交后调用：签名变化即失效重算并 bump 版本号 */
      recompute: function (catalog, cells, stock) {
        var sig = signature(cells, stock);
        if (cache && cache.sig === sig) return cache.result;
        revision += 1;
        cache = { sig: sig, result: evaluate(catalog, cells, stock) };
        return cache.result;
      },
      /* 外部明确声明旧预算失效（如从最近版本恢复网格）：清掉缓存，
         下一次 recompute 按新签名重算并 bump 版本号（bump 只发生在重算处） */
      invalidate: function () {
        cache = null;
      },
      /* 载入既有方案时直接定为已持久化的版本，不额外 bump */
      prime: function (catalog, cells, stock, rev) {
        revision = rev || 1;
        cache = { sig: signature(cells, stock), result: evaluate(catalog, cells, stock) };
        return cache.result;
      },
      revision: function () { return revision; },
      setRevision: function (n) {
        revision = n || 0;
        cache = null;
      },
      get: function () { return cache ? cache.result : null; }
    };
  }

  root.T = root.T || {};
  root.T.createBudget = createBudget;
})(typeof window !== "undefined" ? window : globalThis);
