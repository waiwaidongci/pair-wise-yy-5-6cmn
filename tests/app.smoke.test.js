"use strict";

/*
 * 冒烟测试：用最小 DOM 垫片加载真实 main.js，
 * 走通 落笔 → 库存调整 → 替换（拒绝/成功）→ 撤销重做 → 缩放 → 恢复 → 保存 的完整闭环。
 */

const test = require("node:test");
const assert = require("node:assert/strict");

// ---------- 最小 DOM 垫片 ----------
class El {
  constructor(tag) {
    this.tagName = tag || "div";
    this._html = "";
    this.value = "";
    this.textContent = "";
    this.className = "";
    this.hidden = false;
    this.disabled = false;
    this.style = {};
    this.dataset = {};
    this.onclick = null;
    this.onchange = null;
    this.onpointerdown = null;
    this.onpointerenter = null;
    this.classList = { toggle() {}, add() {}, remove() {} };
    this._cache = new Map();
  }
  set innerHTML(v) { this._html = String(v); this._cache.clear(); }
  get innerHTML() { return this._html; }
  querySelectorAll(sel) {
    if (this._cache.has(sel)) return this._cache.get(sel);
    let out = [];
    if (sel === ".cell") {
      out = [...this._html.matchAll(/data-i="(\d+)"/g)].map(m => { const e = new El(); e.dataset.i = m[1]; return e; });
    } else if (sel === "[data-color]") {
      out = [...this._html.matchAll(/data-color="(\d+)"/g)].map(m => { const e = new El(); e.dataset.color = m[1]; return e; });
    } else if (sel === "[data-stock]") {
      out = [...this._html.matchAll(/value="(\d+)" data-stock="(\d+)"/g)].map(m => {
        const e = new El("input"); e.value = m[1]; e.dataset.stock = m[2]; return e;
      });
    }
    this._cache.set(sel, out);
    return out;
  }
  querySelector() { return null; }
  contains() { return false; }
}

const elements = new Map();
const blockBtns = ["dot", "cross", "diamond"].map(b => { const e = new El("button"); e.dataset.block = b; return e; });
const store = new Map();

global.window = globalThis;
global.document = {
  querySelector: sel => { if (!elements.has(sel)) elements.set(sel, new El()); return elements.get(sel); },
  querySelectorAll: sel => (sel === "[data-block]" ? blockBtns : []),
  createElement: () => new El("a"),
  activeElement: null,
};
window.addEventListener = () => {};
global.localStorage = {
  getItem: k => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: k => store.delete(k),
};

require("../js/budget.js");
require("../js/state.js");
require("../js/history.js");
require("../js/main.js"); // 加载即完成 init

const State = global.BrocadeState;
const $ = sel => elements.get(sel);
const NAMES = ["米白", "朱红", "靛蓝", "藤黄", "松绿", "绛紫", "墨黑", "橘橙"];
const code = i => String(i + 1).padStart(2, "0");

function usedOf(i) {
  const m = $("#stats").innerHTML.match(new RegExp(" " + code(i) + " " + NAMES[i] + "</span><b>(\\d+)</b>"));
  return m ? Number(m[1]) : null;
}
function budgetUsedOf(i) {
  const m = $("#budget").innerHTML.match(new RegExp(code(i) + " " + NAMES[i] + "[\\s\\S]*?已用 (\\d+)"));
  return m ? Number(m[1]) : null;
}
function paintAt(i) { $("#grid").querySelectorAll(".cell")[i].onpointerdown(); }
function setStock(i, v) {
  const input = $("#budget").querySelectorAll("[data-stock]").find(e => e.dataset.stock === String(i));
  input.value = String(v);
  input.onchange();
}
function cellCount() { return $("#grid").querySelectorAll(".cell").length; }

test("冒烟：色线替换与预算闭环全流程", () => {
  // 初始化
  assert.equal(cellCount(), 18 * 14);
  assert.equal($("#palette").querySelectorAll("[data-color]").length, 8);
  assert.equal($("#budget").querySelectorAll("[data-stock]").length, 8);
  assert.equal($("#undoBtn").disabled, true);

  // 落笔 4 格（含右下角 251，稍后用于裁剪）
  paintAt(0); paintAt(1); paintAt(2); paintAt(251);
  assert.equal(usedOf(1), 4);
  assert.equal(budgetUsedOf(1), 4);
  assert.equal($("#undoBtn").disabled, false);

  // 库存不足 → 整次拒绝：画布、统计、预算、历史全部不变
  setStock(3, 1);
  assert.match($("#budget").innerHTML, /value="1" data-stock="3"/);
  $("#replaceFrom").value = "1";
  $("#replaceTo").value = "3";
  $("#replaceBtn").onclick();
  assert.equal($("#toast").className, "show error");
  assert.equal(usedOf(1), 4);
  assert.equal(usedOf(3), 0);
  $("#undoBtn").onclick(); // 若拒绝留下了历史条目，这里撤销的将是它而非落笔
  assert.equal(usedOf(1), 3);
  $("#redoBtn").onclick();
  assert.equal(usedOf(1), 4);

  // 库存充足 → 替换成功：画布 / 统计 / 预算同步更新
  setStock(3, 260);
  $("#replaceBtn").onclick();
  assert.equal($("#toast").className, "show");
  assert.equal(usedOf(1), 0);
  assert.equal(usedOf(3), 4);
  assert.equal(budgetUsedOf(3), 4);

  // 替换是一步历史：一次撤销整体还原，一次重做整体恢复
  $("#undoBtn").onclick();
  assert.equal(usedOf(1), 4);
  assert.equal(usedOf(3), 0);
  $("#redoBtn").onclick();
  assert.equal(usedOf(1), 0);
  assert.equal(usedOf(3), 4);

  // 缩小网格：保留重叠区域，裁掉右下角那格，出现恢复入口
  $("#cols").value = "10";
  $("#rows").value = "8";
  $("#resizeBtn").onclick();
  assert.equal(cellCount(), 80);
  assert.equal(usedOf(3), 3);
  assert.equal($("#versionBar").hidden, false);

  // 恢复最近版本：整幅找回，预算立即重算
  $("#restoreBtn").onclick();
  assert.equal($("#versionBar").hidden, true);
  assert.equal(cellCount(), 18 * 14);
  assert.equal(usedOf(3), 4);
  assert.equal(budgetUsedOf(3), 4);

  // 保存：状态 + 库存 + 历史整体落盘，刷新后一致
  $("#saveBtn").onclick();
  const raw = store.get(State.STORAGE_KEY);
  assert.ok(raw);
  const parsed = State.deserialize(raw);
  assert.equal(parsed.state.cols, 18);
  assert.equal(parsed.state.rows, 14);
  assert.equal(parsed.state.cells[251], 3);
  assert.equal(parsed.state.stock[3], 260);
  assert.ok(parsed.history.undo.length > 0);
});
