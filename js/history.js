/* 历史记录模块：撤销 / 重做。
   每条 entry 是一次完整的原子操作（一笔拖动、一次整笔替换、一次网格调整、一次裁剪恢复）。
   只保存纯数据快照，不触碰规则与预算，保证职责独立。 */
(function (root) {
  "use strict";

  function createHistory(limit) {
    var undoStack = [];
    var redoStack = [];
    var MAX = limit || 60;

    function clone(entry) {
      return {
        label: entry.label,
        at: entry.at,
        cols: entry.cols,
        rows: entry.rows,
        cells: entry.cells.slice(),
        stock: Object.assign({}, entry.stock)
      };
    }

    return {
      push: function (entry) {
        undoStack.push(clone(entry));
        if (undoStack.length > MAX) undoStack.shift();
        redoStack.length = 0;
      },
      undo: function (current) {
        if (!undoStack.length) return null;
        var prev = undoStack.pop();
        redoStack.push(clone(current));
        return prev;
      },
      redo: function (current) {
        if (!redoStack.length) return null;
        var next = redoStack.pop();
        undoStack.push(clone(current));
        return next;
      },
      clear: function () {
        undoStack.length = 0;
        redoStack.length = 0;
      },
      canUndo: function () { return undoStack.length > 0; },
      canRedo: function () { return redoStack.length > 0; },
      sizes: function () { return { undo: undoStack.length, redo: redoStack.length }; },
      meta: function () {
        return {
          undo: undoStack.length ? undoStack[undoStack.length - 1].label : "",
          redo: redoStack.length ? redoStack[redoStack.length - 1].label : ""
        };
      },
      serialize: function () {
        return { undo: undoStack.map(clone), redo: redoStack.map(clone) };
      },
      hydrate: function (data) {
        undoStack = Array.isArray(data.undo) ? data.undo.map(clone) : [];
        redoStack = Array.isArray(data.redo) ? data.redo.map(clone) : [];
      }
    };
  }

  root.T = root.T || {};
  root.T.createHistory = createHistory;
})(typeof window !== "undefined" ? window : globalThis);
