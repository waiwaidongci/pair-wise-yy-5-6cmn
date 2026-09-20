/* 持久化模块：整份状态（含规则、历史、预算版本号）写入 / 读取一次完成。
   刷新后各模块从同一份快照 hydrate，保证一致；并负责旧版（cells 为颜色下标的方案）迁移。 */
(function (root) {
  "use strict";

  var STORAGE_KEY = "zfl31Tapestry.v2";
  var LEGACY_KEY = "zfl31Pattern";

  function memoryAdapter() {
    var map = Object.create(null);
    return {
      getItem: function (k) { return Object.prototype.hasOwnProperty.call(map, k) ? map[k] : null; },
      setItem: function (k, v) { map[k] = String(v); },
      removeItem: function (k) { delete map[k]; }
    };
  }

  function defaultAdapter() {
    try {
      if (typeof localStorage !== "undefined") {
        localStorage.setItem("__t__", "1");
        localStorage.removeItem("__t__");
        return localStorage;
      }
    } catch (e) { /* file:// 或隐私模式下降级为内存 */ }
    return memoryAdapter();
  }

  function createStorage(adapter) {
    var store = adapter || defaultAdapter();

    return {
      save: function (snapshot) {
        store.setItem(STORAGE_KEY, JSON.stringify(snapshot));
      },
      load: function () {
        var raw = store.getItem(STORAGE_KEY);
        if (!raw) return null;
        try { return JSON.parse(raw); } catch (e) { return null; }
      },
      /* 旧版 zfl31Pattern：cells 是颜色下标数组，且无库存 */
      loadLegacy: function (catalog) {
        var raw = store.getItem(LEGACY_KEY);
        if (!raw) return null;
        try {
          var old = JSON.parse(raw);
          if (!old || !Array.isArray(old.cells)) return null;
          var stock = {};
          catalog.forEach(function (c) { stock[c.code] = c.seedStock; });
          var cells = old.cells.map(function (idx) {
            var c = catalog[idx];
            return c ? c.code : null;
          });
          return {
            version: 2,
            cols: old.cols || 18,
            rows: old.rows || 14,
            cells: cells,
            stock: stock,
            savedAt: Date.now(),
            migratedFromLegacy: true
          };
        } catch (e) {
          return null;
        }
      },
      clearLegacy: function () { store.removeItem(LEGACY_KEY); },
      key: function () { return STORAGE_KEY; }
    };
  }

  root.T = root.T || {};
  root.T.createStorage = createStorage;
  root.T.memoryAdapter = memoryAdapter;
})(typeof window !== "undefined" ? window : globalThis);
