"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const State = require("../js/state.js");
const Budget = require("../js/budget.js");
const { createHistory } = require("../js/history.js");

// 造一个带图案的 8×8 状态
function makeState() {
  const s = State.createState(8, 8);
  // 第二行整行填色号1，右下角 2×2 填色号2（用于裁剪测试）
  for (let x = 0; x < 8; x++) s.cells[1 * 8 + x] = 1;
  s.cells[6 * 8 + 6] = 2; s.cells[6 * 8 + 7] = 2;
  s.cells[7 * 8 + 6] = 2; s.cells[7 * 8 + 7] = 2;
  return s;
}

test("色号替换：库存不足时整次拒绝，状态零改动", () => {
  const s = makeState();
  s.stock[3] = 4; // 目标色号库存只有 4 格，而色号1有 8 格
  const before = s.cells.slice();
  const plan = State.planReplace(s, 1, 3);
  assert.equal(plan.ok, false);
  assert.match(plan.reason, /库存不足/);
  // 校验不过则不应用，画布保持原样（不留半成品）
  assert.deepEqual(s.cells, before);
});

test("色号替换：成功后用量整体迁移，预算随之失效重算", () => {
  const s = makeState();
  const budget = Budget.createBudget();
  const before = budget.current(s);
  assert.equal(before.used[1], 8);

  const plan = State.planReplace(s, 1, 3);
  assert.equal(plan.ok, true);
  assert.equal(plan.need, 8);

  const history = createHistory();
  history.commit(s);
  s.cells = State.applyReplace(s, 1, 3);

  budget.invalidate(); // 旧预算立即失效
  const after = budget.current(s);
  assert.equal(after.used[1], 0);
  assert.equal(after.used[3], 8);
  assert.equal(after.rows[3].remaining, s.stock[3] - 8);

  // 替换是一步历史：一次撤销整体还原
  const prev = history.undo(s);
  s.cells = prev.cells;
  budget.invalidate();
  assert.equal(budget.current(s).used[1], 8);
});

test("替换后的导出数据与画布同源一致", () => {
  const s = makeState();
  s.cells = State.applyReplace(s, 1, 2);
  const snap = Budget.createBudget().current(s);
  const exported = State.COLORS.map((c, i) => ({ code: c.code, used: snap.used[i] }));
  assert.equal(exported[1].used, 0);
  assert.equal(exported[2].used, 8 + 4); // 原有 4 格 + 替换迁入 8 格
});

test("落笔：库存不足时整次拒绝，一笔都不画上", () => {
  const s = makeState();
  const used1 = Budget.usageOf(s.cells, s.stock.length)[1];
  s.stock[1] = used1 + 2; // 只剩 2 格余量
  const targets = State.stampTargets(s, 3 * 8 + 3, "cross"); // 十字一次 5 格
  assert.equal(targets.length, 5);
  const plan = State.planPaint(s, targets, 1);
  assert.equal(plan.ok, false);
  assert.match(plan.reason, /整次拒绝/);
  assert.deepEqual(s.cells, makeState().cells); // 未被改动
});

test("落笔：库存足够时整笔生效并扣减预算", () => {
  const s = makeState();
  const budget = Budget.createBudget();
  const targets = State.stampTargets(s, 3 * 8 + 3, "cross");
  const plan = State.planPaint(s, targets, 2);
  assert.equal(plan.ok, true);
  s.cells = State.applyPaint(s, plan.changed, 2);
  budget.invalidate();
  const snap = budget.current(s);
  assert.equal(snap.used[2], 4 + 5);
  assert.equal(snap.rows[2].remaining, s.stock[2] - 9);
});

test("调整网格：保留重叠区域，裁掉部分可统计", () => {
  const s = makeState(); // 8×8，第 2 行是色号1，右下角 2×2 是色号2
  const plan = State.planResize(s, 6, 6);
  assert.equal(plan.cropped, true);
  assert.equal(plan.croppedPainted, 2 + 4); // 第 2 行被裁 2 格 + 右下 2×2 共 4 格
  // 重叠区域（左上 6×6）逐格一致
  for (let y = 0; y < 6; y++) {
    for (let x = 0; x < 6; x++) {
      assert.equal(plan.cells[y * 6 + x], s.cells[y * 8 + x]);
    }
  }
});

test("调整网格：扩大时重叠区域保留，新增格子为底色", () => {
  const s = makeState();
  const plan = State.planResize(s, 10, 9);
  assert.equal(plan.cropped, false);
  for (let y = 0; y < 8; y++) {
    for (let x = 0; x < 8; x++) assert.equal(plan.cells[y * 10 + x], s.cells[y * 8 + x]);
  }
  assert.equal(plan.cells[8], 0); // 新增列
  assert.equal(plan.cells[8 * 10], 0); // 新增行
});

test("裁剪恢复：从最近版本整体恢复，旧预算立即失效重算", () => {
  const s = makeState();
  const history = createHistory();
  const budget = Budget.createBudget();
  budget.current(s);

  // 缩小：先存版本再应用
  history.saveVersion(s);
  history.commit(s);
  const shrunk = State.planResize(s, 6, 6);
  s.cols = shrunk.cols; s.rows = shrunk.rows; s.cells = shrunk.cells;
  budget.invalidate();
  assert.equal(budget.current(s).used[2], 0); // 右下 2×2 已被裁掉

  // 恢复最近版本
  const v = history.latestVersion();
  assert.equal(v.cols, 8);
  history.commit(s);
  history.popVersion();
  s.cols = v.cols; s.rows = v.rows; s.cells = v.cells.slice();
  budget.invalidate(); // 恢复后旧预算立即失效
  const snap = budget.current(s);
  assert.equal(snap.used[1], 8);
  assert.equal(snap.used[2], 4);
  assert.equal(history.latestVersion(), null); // 版本已消费
});

test("历史记录：撤销/重做成对出现，新操作清空重做栈", () => {
  const s = makeState();
  const history = createHistory();
  const original = s.cells.slice();

  history.commit(s);
  s.cells = State.applyReplace(s, 1, 3);
  assert.equal(history.canUndo(), true);
  assert.equal(history.canRedo(), false);

  const undone = history.undo(s);
  s.cells = undone.cells;
  assert.deepEqual(s.cells, original);
  assert.equal(history.canRedo(), true);

  const redone = history.redo(s);
  s.cells = redone.cells;
  assert.equal(Budget.usageOf(s.cells, s.stock.length)[3], 8);

  history.undo(s);
  history.commit(s); // 新操作
  assert.equal(history.canRedo(), false);
});

test("序列化：状态 + 历史整体往返，刷新后一致", () => {
  const s = makeState();
  s.stock[2] = 123;
  s.active = 4;
  s.block = "cross";
  const history = createHistory();
  history.commit(s);
  history.saveVersion(s);

  const json = State.serialize(s, history.toJSON());
  const parsed = State.deserialize(json);
  assert.deepEqual(parsed.state, s);

  const history2 = createHistory();
  history2.load(parsed.history);
  assert.equal(history2.canUndo(), true);
  assert.equal(history2.latestVersion().cols, 8);
  // 恢复出的状态预算与原来一致
  const snap = Budget.createBudget().current(parsed.state);
  assert.equal(snap.used[1], 8);
  assert.equal(snap.rows[2].stock, 123);
});

test("序列化：兼容旧版存档（仅 cols/rows/cells）", () => {
  const legacy = JSON.stringify({ cols: 10, rows: 8, cells: Array(80).fill(2) });
  const parsed = State.deserialize(legacy);
  assert.equal(parsed.state.cols, 10);
  assert.equal(parsed.state.rows, 8);
  assert.deepEqual(parsed.state.stock, State.DEFAULT_STOCK);
  assert.equal(Budget.usageOf(parsed.state.cells, 8)[2], 80);
});

test("序列化：坏数据返回 null，越界色号归底色", () => {
  assert.equal(State.deserialize("not json"), null);
  const parsed = State.deserialize(JSON.stringify({ cols: 6, rows: 6, cells: Array(36).fill(99) }));
  assert.deepEqual(parsed.state.cells, Array(36).fill(0));
});

test("渲染预算：invalidate 之前复用缓存，之后按新状态重算", () => {
  const s = makeState();
  const budget = Budget.createBudget();
  const snap1 = budget.current(s);
  assert.equal(budget.current(s), snap1); // 缓存命中，同一引用
  s.cells = State.applyReplace(s, 1, 5);
  const snap2 = budget.current(s); // cells 引用变化 → 自动重算
  assert.notEqual(snap2, snap1);
  assert.equal(snap2.used[5], 8);
});

test("纹样块：菱形为 13 格实心菱形，越界落点被裁掉", () => {
  const s = State.createState(10, 10);
  assert.equal(State.stampTargets(s, 5 * 10 + 5, "diamond").length, 13);
  assert.equal(State.stampTargets(s, 0, "cross").length, 3); // 左上角十字只剩 3 格
  assert.equal(State.stampTargets(s, 0, "dot").length, 1);
});
