/* UI 层：只负责把「规则模块」的同一次提交结果，
   一次性刷新到画布、撤销/重做按钮、用色统计、重复预览、预算单与导出数据。
   不在此处做任何库存判断或状态变更——全部走 state 的原子入口。 */
(function () {
  "use strict";

  var $ = function (id) { return document.getElementById(id); };
  if (!$("grid")) return; // 非页面环境（Node 冒烟测试）下直接退出

  var state = T.createState();
  var catalog = state.catalog;
  var colorOf = {};
  catalog.forEach(function (c) { colorOf[c.code] = c.color; });

  var active = "R02";
  var block = "dot";
  var stroking = false, strokeDead = false;

  var gridEl = $("grid"), paletteEl = $("palette"), stockListEl = $("stockList");
  var statsEl = $("stats"), previewEl = $("preview"), riskEl = $("risk");
  var budgetEl = $("budget"), msgEl = $("msg"), trimBar = $("trimBar");
  var undoBtn = $("undoBtn"), redoBtn = $("redoBtn"), histTip = $("histTip");
  var fromSel = $("replaceFrom"), toSel = $("replaceTo");
  var replaceHint = $("replaceHint"), replaceMsg = $("replaceMsg");

  function esc(s) { return String(s).replace(/[&<>"]/g, function (ch) {
    return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[ch];
  }); }

  function flash(text, isError) {
    msgEl.textContent = text || "";
    msgEl.className = isError ? "warning" : "ok";
  }

  function fmtTime(t) {
    if (!t) return "尚未保存（每次改动已自动暂存）";
    var d = new Date(t);
    var p = function (n) { return String(n).padStart(2, "0"); };
    return "已保存至本地 · " + p(d.getHours()) + ":" + p(d.getMinutes()) + ":" + p(d.getSeconds());
  }

  /* —— 每笔操作后唯一的刷新入口 —— */
  function renderAll() {
    var v = state.view();
    $("cols").value = v.cols;
    $("rows").value = v.rows;
    renderPalette(v);
    renderStock(v);
    renderGrid(v);
    renderBudget(v);
    renderStats(v);
    renderPreview(v);
    renderRisk(v);
    renderHistory(v);
    renderTrim(v);
    renderReplace(v);
    $("savedAt").textContent = fmtTime(v.savedAt);
  }

  function renderPalette(v) {
    var needOf = {};
    v.budget.rows.forEach(function (r) { needOf[r.code] = r.need; });
    paletteEl.innerHTML = v.catalog.map(function (c) {
      var free = (v.stock[c.code] || 0) - needOf[c.code];
      return '<button class="swatch ' + (c.code === active ? "active" : "") +
        '" data-code="' + c.code + '" title="' + esc(c.name) + '" style="background:' + c.color + '">' +
        '<span class="sw-code">' + c.code + '</span>' +
        '<span class="sw-free ' + (free < 0 ? "low" : free <= 8 ? "low" : "") + '">余 ' + free + '</span></button>';
    }).join("");
    paletteEl.querySelectorAll("[data-code]").forEach(function (el) {
      el.onclick = function () { active = el.dataset.code; replaceMsg.textContent = ""; renderAll(); };
    });
  }

  function renderStock(v) {
    var rowOf = {};
    v.budget.rows.forEach(function (r) { rowOf[r.code] = r; });
    stockListEl.innerHTML = v.catalog.map(function (c) {
      var row = rowOf[c.code];
      return '<div class="stock-row">' +
        '<span class="chip" style="background:' + c.color + '"></span>' +
        '<span>' + c.code + '</span>' +
        '<span style="color:#76695e">' + esc(c.name) + '</span>' +
        '<input type="number" min="0" step="1" value="' + v.stock[c.code] + '" data-stock="' + c.code +
        '" aria-label="' + c.code + '库存">' +
        '<span class="free ' + (row.over ? "over" : "") + '" data-free-for="' + c.code + '">余 ' + row.free + '</span>' +
        "</div>";
    }).join("");
    stockListEl.querySelectorAll("[data-stock]").forEach(function (el) {
      el.onchange = function () {
        var res = state.setStock(el.dataset.stock, el.value);
        if (!res.ok) flash(res.error, true);
        else flash("色号 " + el.dataset.stock + " 库存已更新，预算单已重算", false);
        renderAll();
      };
    });
  }

  function renderGrid(v) {
    gridEl.style.gridTemplateColumns = "repeat(" + v.cols + ", 1fr)";
    gridEl.innerHTML = v.cells.map(function (val, i) {
      return '<div class="cell" data-i="' + i + '" style="background:' +
        (val ? colorOf[val] : "#f8ead2") + '"></div>';
    }).join("");
    gridEl.querySelectorAll(".cell").forEach(function (el) {
      el.onpointerdown = function (e) {
        e.preventDefault();
        startStroke(Number(el.dataset.i));
      };
      el.onpointerenter = function () {
        if (stroking && !strokeDead) continueStroke(Number(el.dataset.i));
      };
    });
  }

  function patternTargets(i) {
    var v = state.view();
    var x = i % v.cols, y = Math.floor(i / v.cols);
    function idx(xx, yy) {
      return (xx < 0 || xx >= v.cols || yy < 0 || yy >= v.rows) ? -1 : yy * v.cols + xx;
    }
    var ts;
    if (block === "cross") ts = [i, idx(x - 1, y), idx(x + 1, y), idx(x, y - 1), idx(x, y + 1)];
    else if (block === "diamond") ts = [idx(x, y - 1), idx(x - 1, y), i, idx(x + 1, y), idx(x, y + 1)];
    else ts = [i];
    return ts.filter(function (t) { return t >= 0; });
  }

  function startStroke(i) {
    var b = state.beginStroke(active);
    if (!b.ok) { flash(b.error, true); return; }
    stroking = true; strokeDead = false;
    var res = state.applyStroke(patternTargets(i));
    if (res.rejected) {
      stroking = false; strokeDead = true;
      flash(res.error, true);
    }
    renderAll();
  }

  function continueStroke(i) {
    var res = state.applyStroke(patternTargets(i));
    if (res.rejected) {
      stroking = false; strokeDead = true;
      flash(res.error, true);
    }
    renderAll();
  }

  window.addEventListener("pointerup", function () {
    if (!stroking) return;
    stroking = false;
    var res = state.endStroke("填色（一笔）");
    if (res.ok && !res.noop) flash("填色已提交：画布 / 历史 / 统计 / 预览 / 导出同步更新", false);
    renderAll();
  });

  function renderBudget(v) {
    var b = v.budget;
    budgetEl.innerHTML =
      '<div class="budget-head"><span>渲染预算单</span><span style="font-size:12px">版本 #' + b.revision + "</span></div>" +
      b.rows.map(function (r) {
        return '<div class="budget-row' + (r.over ? " over" : "") + '">' +
          '<span class="chip" style="background:' + r.color + '"></span>' +
          "<span>" + r.code + " " + esc(r.name) + "</span>" +
          "<span>用 " + r.need + "</span>" +
          "<span>存 " + r.stock + "</span></div>";
      }).join("") +
      '<div class="budget-total">总需求 ' + b.totalNeed + " 格 ／ 总库存 " + b.totalStock + " 格 ｜ 空格 " +
      b.emptyCells + " 格</div>" +
      (b.short
        ? '<p class="warning">超支色号：' + b.shortCodes.join("、") + "，共缺 " + b.shortageCells + " 格</p>"
        : '<p class="ok">预算闭合：各色号库存均满足渲染需求。</p>');
  }

  function renderStats(v) {
    statsEl.innerHTML = v.budget.rows.map(function (r) {
      return '<div class="stat"><span><span style="display:inline-block;width:14px;height:14px;background:' +
        r.color + ';vertical-align:-2px"></span> ' + r.code + " " + esc(r.name) +
        "</span><b>" + r.need + "</b></div>";
    }).join("");
  }

  function renderPreview(v) {
    var W = 6, H = 6;
    var html = "";
    for (var y = 0; y < H; y++) {
      for (var x = 0; x < W; x++) {
        var val = y < v.rows && x < v.cols ? v.cells[y * v.cols + x] : null;
        html += '<div class="mini" style="background:' + (val ? colorOf[val] : "#f8ead2") + '"></div>';
      }
    }
    previewEl.innerHTML = html;
  }

  function renderRisk(v) {
    var riskRows = [];
    for (var y = 0; y < v.rows; y++) {
      var switches = 0;
      for (var x = 1; x < v.cols; x++) {
        if (v.cells[y * v.cols + x] !== v.cells[y * v.cols + x - 1]) switches++;
      }
      if (switches > v.cols * 0.62) riskRows.push(y + 1);
    }
    riskEl.innerHTML = riskRows.length
      ? '<p class="warning">第' + riskRows.join("、") + "行换色过密，可能断线。</p>"
      : "<p>暂无明显断线风险。</p>";
  }

  function renderHistory(v) {
    var s = v.hist.sizes, m = v.hist.meta;
    undoBtn.disabled = s.undo === 0;
    redoBtn.disabled = s.redo === 0;
    undoBtn.textContent = "撤销" + (m.undo ? "：" + m.undo : "");
    redoBtn.textContent = "重做" + (m.redo ? "：" + m.redo : "");
    histTip.textContent = "历史 " + s.undo + " 步可撤销、" + s.redo + " 步可重做（每笔原子操作只占一条）";
  }

  function renderTrim(v) {
    if (v.lastTrim) {
      trimBar.className = "trimbar show";
      trimBar.innerHTML = "最近一次缩网格裁掉了图案（" + v.lastTrim.cols + "×" + v.lastTrim.rows +
        "，" + new Date(v.lastTrim.at).toLocaleTimeString() + "）。恢复后旧预算立即失效并重算。" +
        '<button id="trimRestoreBtn">从最近版本恢复被裁图案</button>';
      $("trimRestoreBtn").onclick = function () {
        var res = state.restoreTrim();
        if (!res.ok) { flash(res.error, true); }
        else flash("已恢复最近裁剪版本：旧预算作废，已按恢复后画布重算（预算单 #" + res.budget.revision + "）", false);
        renderAll();
      };
    } else {
      trimBar.className = "trimbar";
      trimBar.innerHTML = "";
    }
  }

  function renderReplace(v) {
    if (!fromSel.options.length) {
      catalog.forEach(function (c) {
        fromSel.add(new Option(c.code + " " + c.name, c.code));
        toSel.add(new Option(c.code + " " + c.name, c.code));
      });
      fromSel.value = "R02";
      toSel.value = "B03";
    }
    var from = fromSel.value, to = toSel.value;
    var rowOf = {};
    v.budget.rows.forEach(function (r) { rowOf[r.code] = r; });
    var rf = rowOf[from], rt = rowOf[to];
    var after = from === to ? rt.need : rf.need + rt.need;
    var freeAfter = rt.stock - after;
    $("replaceBtn").disabled = from === to;
    replaceHint.innerHTML = from === to
      ? "请选择不同的源色号与目标色号。"
      : "画布上 " + from + " 共 <b>" + rf.need + "</b> 格；替换后 " + to + " 将使用 <b>" + after +
        "</b> 格，库存 " + rt.stock + " 格，" +
        (freeAfter >= 0 ? '余量 <span class="ok">' + freeAfter + "</span>"
                        : '缺口 <span class="warning">' + (-freeAfter) + "</span>");
  }

  /* —— 事件：整笔替换 / 网格 / 撤销重做 / 保存导出 / 纹样块 —— */

  function doReplace() {
    var res = state.replaceColor(fromSel.value, toSel.value);
    if (!res.ok) {
      replaceMsg.className = "warning";
      replaceMsg.textContent = res.error;
      flash(res.error, true);
    } else {
      replaceMsg.className = "ok";
      replaceMsg.textContent = "已替换 " + res.replaced + " 格：" + res.from + "→" + res.to +
        "，画布/历史/统计/预览/导出一次更新（预算单 #" + res.budget.revision + "）";
      flash(replaceMsg.textContent, false);
    }
    renderAll();
  }
  $("replaceBtn").onclick = doReplace;
  fromSel.onchange = function () { replaceMsg.textContent = ""; renderReplace(state.view()); };
  toSel.onchange = function () { replaceMsg.textContent = ""; renderReplace(state.view()); };

  $("resizeBtn").onclick = function () {
    var res = state.resize($("cols").value, $("rows").value);
    if (!res.ok) { flash(res.error, true); renderAll(); return; }
    if (res.noop) { flash("网格尺寸未变化", false); return; }
    flash("网格已调整，重叠区域保留" +
      (res.cut ? "；裁掉 " + res.cut + " 格图案，可从最近版本恢复" : "，未裁掉图案"), false);
    renderAll();
  };

  undoBtn.onclick = function () {
    var res = state.undo();
    if (!res.ok) flash(res.error, true);
    else flash("已撤销（预算单 #" + res.budget.revision + "）", false);
    renderAll();
  };
  redoBtn.onclick = function () {
    var res = state.redo();
    if (!res.ok) flash(res.error, true);
    else flash("已重做（预算单 #" + res.budget.revision + "）", false);
    renderAll();
  };

  $("saveBtn").onclick = function () {
    var res = state.save();
    flash("方案已保存到本地（" + new Date(res.savedAt).toLocaleTimeString() + "），刷新后一致", false);
    renderAll();
  };

  $("exportBtn").onclick = function () {
    var data = state.getExport(); // 与当前画布/统计/预览同源，且含最新预算单
    var blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
    var a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "brocade-pattern-bv" + data.budget.revision + ".json";
    a.click();
    URL.revokeObjectURL(a.href);
    flash("已导出当前已提交状态（预算单 #" + data.budget.revision + "）", false);
  };

  document.querySelectorAll("[data-block]").forEach(function (btn) {
    btn.onclick = function () {
      block = btn.dataset.block;
      document.querySelectorAll("[data-block]").forEach(function (b) {
        b.classList.toggle("active", b === btn);
      });
    };
  });

  renderAll();
})();
