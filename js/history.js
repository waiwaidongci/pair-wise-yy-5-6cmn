/*
 * 历史记录模块
 * 职责：撤销 / 重做栈，以及网格缩小前的"最近版本"快照（用于恢复被裁掉的图案）。
 * 可整体序列化 / 反序列化，刷新后历史一致。不依赖其他模块。
 */
(function (global) {
  "use strict";

  const HISTORY_LIMIT = 50;
  const VERSION_LIMIT = 5;

  function createHistory() {
    let undoStack = [];
    let redoStack = [];
    let versions = [];

    const snap = s => ({ cols: s.cols, rows: s.rows, cells: s.cells.slice() });

    return {
      // 在变更生效前调用：把当前状态压入撤销栈，并清空重做栈
      commit(state) {
        undoStack.push(snap(state));
        if (undoStack.length > HISTORY_LIMIT) undoStack.shift();
        redoStack = [];
      },
      // 撤销：返回上一个快照（调用方负责应用）；无可撤销时返回 null
      undo(state) {
        if (!undoStack.length) return null;
        redoStack.push(snap(state));
        return undoStack.pop();
      },
      redo(state) {
        if (!redoStack.length) return null;
        undoStack.push(snap(state));
        return redoStack.pop();
      },
      canUndo: () => undoStack.length > 0,
      canRedo: () => redoStack.length > 0,

      // 网格缩小前留存完整版本，供"恢复最近版本"使用
      saveVersion(state) {
        versions.push(Object.assign(snap(state), { at: Date.now() }));
        if (versions.length > VERSION_LIMIT) versions.shift();
      },
      latestVersion: () => versions[versions.length - 1] || null,
      popVersion: () => versions.pop() || null,
      versionCount: () => versions.length,

      clear() { undoStack = []; redoStack = []; versions = []; },

      toJSON() { return { undo: undoStack, redo: redoStack, versions }; },
      load(data) {
        if (!data || typeof data !== "object") return;
        const ok = e => e && Number.isInteger(e.cols) && Number.isInteger(e.rows) &&
          Array.isArray(e.cells) && e.cells.length === e.cols * e.rows;
        undoStack = (Array.isArray(data.undo) ? data.undo : []).filter(ok);
        redoStack = (Array.isArray(data.redo) ? data.redo : []).filter(ok);
        versions = (Array.isArray(data.versions) ? data.versions : []).filter(ok);
      },
    };
  }

  const api = { createHistory, HISTORY_LIMIT, VERSION_LIMIT };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  global.BrocadeHistory = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
