/* App bridge: in the Android app, links to received files (blob: URLs) cannot download.
   This saves the file to the app's cache and opens the Android share sheet, so it can be
   opened in a PDF viewer, saved to Files, or sent on. In a normal browser it does nothing. */
(function () {
  var C = window.Capacitor;
  if (!C || !C.isNativePlatform || !C.isNativePlatform()) return;
  var P = C.Plugins || {};
  function toast(msg) {
    var t = document.createElement('div');
    t.textContent = msg;
    t.style.cssText = 'position:fixed;left:16px;right:16px;bottom:calc(16px + env(safe-area-inset-bottom,0px));z-index:9999;padding:12px 14px;border-radius:10px;background:#14181d;color:#fff;font:14px system-ui,sans-serif;text-align:center';
    document.body.appendChild(t); setTimeout(function () { t.remove(); }, 4000);
  }
  function b64(blob) {
    return new Promise(function (res, rej) { var r = new FileReader(); r.onload = function () { res(String(r.result).split(',')[1] || ''); }; r.onerror = rej; r.readAsDataURL(blob); });
  }
  async function shareBlob(url, name) {
    if (!P.Filesystem || !P.Share) { toast('Saving files is not available in this version of the app.'); return; }
    var blob = await (await fetch(url)).blob();
    var safe = (name || 'received-file').replace(/[\/\\:*?"<>|]/g, '_').slice(0, 120);
    var r = await P.Filesystem.writeFile({ path: safe, data: await b64(blob), directory: 'CACHE' });
    try { await P.Share.share({ title: safe, files: [r.uri] }); }
    catch (e) { if (!/cancel/i.test(String(e && e.message))) toast('Could not open the share sheet: ' + (e && e.message || e)); }
  }
  document.addEventListener('click', function (e) {
    var a = e.target && e.target.closest && e.target.closest('a[href^="blob:"]');
    if (!a) return;
    e.preventDefault(); e.stopPropagation();
    var name = a.getAttribute('download');
    if (!name) { var twin = document.querySelector('a[download][href="' + a.getAttribute('href') + '"]'); name = twin && twin.getAttribute('download'); }
    shareBlob(a.href, name).catch(function (err) { toast('Could not save the file: ' + (err && err.message || err)); });
  }, true);
})();
