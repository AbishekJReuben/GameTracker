// Holds requestAnimationFrame callbacks while the desktop window is hidden in the tray.
//
// A classic script on purpose: it has to run before any module, because Motion's
// frameloop captures `requestAnimationFrame` when its module is evaluated, and ES
// imports all run before main.tsx's body. src/lib/useVisible.ts sets `hold` (see the
// comment there for why the browser doesn't do this itself behind the tray).
(function () {
  var nativeRequest = window.requestAnimationFrame.bind(window);
  var nativeCancel = window.cancelAnimationFrame.bind(window);
  // Negative ids can never collide with the browser's (positive) ones.
  var held = new Map();
  var nextId = -1;
  var gate = {
    hold: false,
    release: function () {
      if (!held.size) return;
      // Entries stay in the map until their frame, so a cancel in between still works.
      nativeRequest(function (time) {
        held.forEach(function (callback, id) {
          held.delete(id);
          try {
            callback(time);
          } catch (error) {
            queueMicrotask(function () {
              throw error;
            });
          }
        });
      });
    },
  };
  window.requestAnimationFrame = function (callback) {
    if (!gate.hold) return nativeRequest(callback);
    held.set(nextId, callback);
    return nextId--;
  };
  window.cancelAnimationFrame = function (id) {
    if (id < 0) held.delete(id);
    else nativeCancel(id);
  };
  window.__gtFrameGate = gate;
})();
