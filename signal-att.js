/* Signal Traffic first-party attribution (first-touch). Runs only on this site.
   Records a pageview (visitor id, referrer, UTMs, landing path) for revenue
   attribution and appends reference_id to Polar checkout links.
   Nothing here touches uploaded log files - those still never leave your device. */
(function () {
  var W = "https://shuttlewright-signal-attr.pillar-3a8.workers.dev";
  var vid = null;
  try { vid = localStorage.getItem("st_vid"); } catch (e) {}
  if (!vid) {
    vid = (crypto.randomUUID ? crypto.randomUUID() : "v" + Date.now() + "-" + Math.random().toString(36).slice(2));
    try { localStorage.setItem("st_vid", vid); } catch (e) {}
  }
  var q = new URLSearchParams(location.search);
  var utm = {};
  ["utm_source", "utm_medium", "utm_campaign", "utm_content", "utm_term"].forEach(function (k) {
    var v = q.get(k); if (v) utm[k] = v;
  });
  var ev = { vid: vid, ref: document.referrer || "", path: location.pathname, ts: new Date().toISOString(), utm: utm };
  try {
    if (navigator.sendBeacon) navigator.sendBeacon(W + "/api/ev", new Blob([JSON.stringify(ev)], { type: "application/json" }));
    else fetch(W + "/api/ev", { method: "POST", body: JSON.stringify(ev), keepalive: true });
  } catch (e) {}
  function rewrite(a) {
    try {
      var u = new URL(a.href);
      if (!/buy\.polar\.sh/.test(u.hostname)) return;
      u.searchParams.set("reference_id", vid);
      Object.keys(utm).forEach(function (k) { if (!u.searchParams.get(k)) u.searchParams.set(k, utm[k]); });
      a.href = u.toString();
    } catch (e) {}
  }
  function rewriteAll() { document.querySelectorAll('a[href*="buy.polar.sh"]').forEach(rewrite); }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", rewriteAll);
  else rewriteAll();
  document.addEventListener("click", function (e) {
    var a = e.target && e.target.closest ? e.target.closest('a[href*="buy.polar.sh"]') : null;
    if (a) rewrite(a);
  }, true);
})();
