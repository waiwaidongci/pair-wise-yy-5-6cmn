/* 冒烟测试（无浏览器）：node tools/smoke.js
   验证：库存不足整笔拒绝不留半成品、替换一处更新全部视图同源数据、
   调网格保留重叠/裁剪恢复预算失效重算、刷新（重建状态）后一致。 */
const fs = require("fs");
const path = require("path");
const vm = require("vm");

["history.js", "budget.js", "storage.js", "state.js"].forEach((f) => {
  vm.runInThisContext(fs.readFileSync(path.join(__dirname, "..", "js", f), "utf8"), { filename: f });
});

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log("  PASS " + name); }
  else { fail++; console.log("  FAIL " + name + (extra ? "  >>> " + extra : "")); }
}
function count(cells, code) { return cells.filter((v) => v === code).length; }

/* 1. 初始状态：预算闭合 */
let adapter = T.memoryAdapter();
let store = () => T.createStorage(adapter);
let s = T.createState({ storage: store() });

ok("初始 18×14", s.view().cols === 18 && s.view().rows === 14);
ok("初始预算闭合", s.view().budget.short === false);
ok("初始预算版本 #1", s.view().budget.revision === 1);

/* 2. 一笔填色：占用库存并记一条历史 */
s.beginStroke("G05");
s.applyStroke([20, 21, 22]);
let r = s.endStroke("填色（一笔）");
ok("填色成功提交", r.ok === true && r.budget.revision === 2);
ok("填色记一条历史", s.view().hist.sizes.undo === 1);
ok("填色扣减可用余量", (function () {
  let row = s.view().budget.rows.find((x) => x.code === "G05");
  return row.free === row.stock - 3;
})());

/* 3. 整笔替换：库存不足 → 整次拒绝，画布/历史/预算/导出全部不变 */
s.setStock("O08", 1); // O08 当前画布 0 格，替换后需要 R02 的 5 格，库存只有 1
let stableExport = s.getExport();
let beforeSnap = JSON.stringify(stableExport).replace(/"generatedAt":"[^"]*"/, "");
let beforeCells = JSON.stringify(s.view().cells);
let beforeHist = s.view().hist.sizes.undo;
let beforeRev = s.view().budget.revision;
let rep = s.replaceColor("R02", "O08");
ok("库存不足替换被拒绝", rep.ok === false && rep.rejected === true, rep.error);
ok("拒绝后画布零改动", count(s.view().cells, "R02") === 5 && count(s.view().cells, "O08") === 0);
ok("拒绝不留半成品（无R02→O08混染）",
  JSON.stringify(s.view().cells) === beforeCells &&
  JSON.stringify(s.getExport()).replace(/"generatedAt":"[^"]*"/, "") === beforeSnap);
ok("拒绝不写历史", s.view().hist.sizes.undo === beforeHist);
ok("拒绝不 bump 预算版本", s.view().budget.revision === beforeRev);

/* 4. 库存补足后整笔替换成功，所有视图同源更新 */
s.setStock("O08", 32);
rep = s.replaceColor("R02", "O08");
ok("替换成功", rep.ok === true && rep.replaced === 5);
ok("画布已替换", count(s.view().cells, "R02") === 0 && count(s.view().cells, "O08") === 5);
ok("导出与画布同源", (function () {
  let ex = s.getExport();
  let oc = ex.usage.find((u) => u.code === "O08");
  return ex.cells === s.view().cells ? false : JSON.stringify(ex.cells) === JSON.stringify(s.view().cells) && oc.count === 5;
})());
ok("替换后预算闭合", s.view().budget.short === false);
ok("替换写一条历史", s.view().hist.sizes.undo === beforeHist + 1); // setStock 不入栈

/* 5. 撤销替换后画布/预算/导出一致回退 */
s.undo();
ok("撤销恢复 R02", count(s.view().cells, "R02") === 5 && count(s.view().cells, "O08") === 0);
ok("撤销后历史栈正确", s.view().hist.sizes.undo === 1 && s.view().hist.sizes.redo === 1);
s.redo();
ok("重做回到 O08", count(s.view().cells, "O08") === 5);

/* 6. 缩小网格：保留重叠区域，被裁图案可从最近版本恢复，恢复后预算失效重算 */
let pre = s.view();
let rv = s.resize(10, 10);
ok("缩小网格成功", rv.ok === true && s.view().cols === 10 && s.view().rows === 10);
ok("重叠区域保留", (function () {
  let v = s.view();
  for (let y = 0; y < 10; y++)
    for (let x = 0; x < 10; x++)
      if (v.cells[y * 10 + x] !== pre.cells[y * pre.cols + x]) return false;
  return true;
})());
ok("存在裁剪版本可恢复", !!s.view().lastTrim);
let revBeforeRestore = s.view().budget.revision;
let rest = s.restoreTrim();
ok("恢复成功并强制预算失效", rest.ok === true && rest.budget.revision > revBeforeRestore);
ok("恢复后回到 18×14", s.view().cols === 18 && s.view().rows === 14);
ok("恢复后旧版本清空", s.view().lastTrim === null);
ok("恢复后预算与画布重算一致", (function () {
  let b = s.view().budget;
  return b.filledCells === count(s.view().cells, "O08") + count(s.view().cells, "B03") +
    count(s.view().cells, "Y04") + count(s.view().cells, "G05");
})());

/* 7. 填色库存不足：一笔内中途超额 → 整笔回滚 */
s.setStock("Y04", 6); // 画布已有 5 格 Y04，仅余 1 格
s.beginStroke("Y04");
let ar = s.applyStroke([0, 1, 2, 3]); // 想新涂 4 格
ok("超额填色被整笔拒绝", ar.ok === false && ar.rejected === true && ar.deficit === 3);
let er = s.endStroke("填色（一笔）");
ok("被拒笔不产生提交", er.ok === false);
ok("回滚后画布无半成品", s.view().cells[0] === null && s.view().cells[1] === null && count(s.view().cells, "Y04") === 5);

/* 8. 刷新一致：用同一持久层重建状态，规则/历史/预算全部 hydrate */
let s2 = T.createState({ storage: store() });
ok("刷新后网格一致", s2.view().cols === 18 && s2.view().rows === 14);
ok("刷新后画布一致", JSON.stringify(s2.view().cells) === JSON.stringify(s.view().cells));
ok("刷新后库存一致", JSON.stringify(s2.view().stock) === JSON.stringify(s.view().stock));
ok("刷新后预算版本一致", s2.view().budget.revision === s.view().budget.revision);
ok("刷新后历史一致（可撤销）", s2.view().hist.sizes.undo === s.view().hist.sizes.undo && s2.view().hist.meta.undo !== "");
ok("刷新后预算仍闭合", s2.view().budget.short === false);
s2.undo(); // 撤销「恢复裁剪版本」→ 10×10（替换后状态）
ok("撤销1回到缩小网格", s2.view().cols === 10 && s2.view().rows === 10 && count(s2.view().cells, "O08") === 5);
s2.undo(); // 撤销「调整网格」→ 18×14（替换后状态）
ok("撤销2回到替换后", s2.view().cols === 18 && count(s2.view().cells, "R02") === 0 && count(s2.view().cells, "O08") === 5);
s2.undo(); // 撤销「整笔替换」→ R02 回来
ok("撤销3恢复R02", count(s2.view().cells, "R02") === 5 && count(s2.view().cells, "O08") === 0);

/* 9. 导出结构：含库存与预算闭环数据 */
let ex = s2.getExport();
ok("导出含 cells/stock/budget/usage", !!(ex.cells && ex.stock && ex.budget && ex.usage));
ok("导出预算 revision 与视图一致", ex.budget.revision === s2.view().budget.revision);

console.log("\n" + pass + " passed, " + fail + " failed");
process.exit(fail ? 1 : 0);
