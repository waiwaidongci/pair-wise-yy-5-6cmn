/*
 * 渲染预算模块
 * 职责：由画布状态推导各色号用量 / 剩余库存；状态一变即 invalidate（旧预算立即失效），
 * 下次读取时重算，保证撤销、恢复、刷新后预算始终与画布一致。
 * 不依赖其他模块；除 renderBudget 外均为纯函数，可在 Node 中独立测试。
 */
(function (global) {
  "use strict";

  // 统计 cells 中各色号的使用格数
  function usageOf(cells, colorCount) {
    const used = Array(colorCount).fill(0);
    for (const v of cells) if (Number.isInteger(v) && v >= 0 && v < colorCount) used[v]++;
    return used;
  }

  function compute(state) {
    const used = usageOf(state.cells, state.stock.length);
    const rows = state.stock.map((stock, i) => ({
      index: i,
      stock,
      used: used[i],
      remaining: stock - used[i],
      over: used[i] > stock,
    }));
    return { used, rows, anyOver: rows.some(r => r.over) };
  }

  // 预算句柄：带失效标记的派生缓存。state.cells / state.stock 以不可变方式替换，
  // 引用变化或显式 invalidate 都会触发重算。
  function createBudget() {
    let dirty = true;
    let cache = null;
    return {
      invalidate() { dirty = true; },
      current(state) {
        if (dirty || !cache || cache.cells !== state.cells || cache.stock !== state.stock) {
          cache = { cells: state.cells, stock: state.stock, snap: compute(state) };
          dirty = false;
        }
        return cache.snap;
      },
    };
  }

  // 预算面板渲染（DOM 只出现在这里，与状态规则解耦）
  function renderBudget(el, snap, colors, onStock) {
    el.innerHTML = snap.rows.map(r => {
      const c = colors[r.index];
      const tight = r.remaining <= Math.max(10, Math.ceil(r.stock * 0.1));
      const cls = r.over ? "bad" : tight ? "warn" : "ok";
      const label = r.over ? "超支" : tight ? "紧张" : "充足";
      return '<div class="budget-row">' +
        '<span class="chip" style="background:' + c.hex + '"></span>' +
        '<span class="bname">' + c.code + " " + c.name + '</span>' +
        '<span class="remain ' + cls + '">' + label + '</span>' +
        '<span class="bstock">库存 <input type="number" min="0" max="99999" value="' + r.stock + '" data-stock="' + r.index + '">' +
        " 已用 " + r.used + " · 余 " + r.remaining + "</span>" +
        "</div>";
    }).join("");
    el.querySelectorAll("[data-stock]").forEach(input => {
      input.onchange = () => {
        const v = Math.max(0, Math.round(Number(input.value) || 0));
        onStock(Number(input.dataset.stock), v);
      };
    });
  }

  const api = { usageOf, createBudget, renderBudget };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  global.BrocadeBudget = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
