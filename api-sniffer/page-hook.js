'use strict';
/* 注入到页面主世界（MAIN world），在页面脚本之前劫持 fetch / XHR / sendBeacon，
   把每一次网络调用的方法、URL、请求体、响应体通过 postMessage 发给 content.js */
(function () {
  if (window.__apiSnifferHooked) return;
  window.__apiSnifferHooked = true;

  var MAX_BODY = 4096;

  function trunc(s) {
    s = String(s == null ? '' : s);
    return s.length > MAX_BODY ? s.slice(0, MAX_BODY) + '\n…(truncated)' : s;
  }

  function absUrl(u) {
    try { return new URL(String(u), location.href).href; }
    catch (e) { return String(u); }
  }

  function bodyToText(b) {
    if (b == null) return '';
    if (typeof b === 'string') return b;
    try {
      if (typeof URLSearchParams !== 'undefined' && b instanceof URLSearchParams) return b.toString();
      if (typeof FormData !== 'undefined' && b instanceof FormData) {
        var parts = [];
        b.forEach(function (v, k) { parts.push(k + '=' + (typeof v === 'string' ? v : '[file]')); });
        return parts.join('&');
      }
      if (typeof Blob !== 'undefined' && b instanceof Blob) return '[Blob ' + b.size + ' bytes]';
      if (b instanceof ArrayBuffer) return '[ArrayBuffer ' + b.byteLength + ' bytes]';
      if (typeof ReadableStream !== 'undefined' && b instanceof ReadableStream) return '[stream]';
      return String(b);
    } catch (e) { return '[body]'; }
  }

  function send(payload) {
    try {
      payload.__apiSniffer = true;
      window.postMessage(payload, '*');
    } catch (e) { /* ignore */ }
  }

  /* ---------- fetch ---------- */
  try {
    var origFetch = window.fetch;
    if (origFetch) {
      window.fetch = function (input, init) {
        var method = 'GET', url = '', reqBody = '';
        try {
          if (typeof input === 'string') { url = input; }
          else if (input) { url = input.url || ''; method = input.method || 'GET'; }
          if (init && init.method) method = init.method;
          reqBody = bodyToText(init && init.body);
        } catch (e) { /* ignore */ }
        var started = Date.now();
        var fullUrl = absUrl(url);
        return origFetch.apply(this, arguments).then(function (resp) {
          try {
            resp.clone().text().then(function (t) {
              send({ kind: 'http', method: method, url: fullUrl, status: resp.status,
                     reqBody: trunc(reqBody), respBody: trunc(t), time: started });
            }).catch(function () {
              send({ kind: 'http', method: method, url: fullUrl, status: resp.status,
                     reqBody: trunc(reqBody), respBody: '[unreadable]', time: started });
            });
          } catch (e) { /* ignore */ }
          return resp;
        }).catch(function (err) {
          send({ kind: 'http', method: method, url: fullUrl, status: 0,
                 reqBody: trunc(reqBody), respBody: '',
                 error: String((err && err.message) || err), time: started });
          throw err;
        });
      };
    }
  } catch (e) { /* ignore */ }

  /* ---------- XMLHttpRequest ---------- */
  try {
    var origOpen = XMLHttpRequest.prototype.open;
    var origSend = XMLHttpRequest.prototype.send;
    XMLHttpRequest.prototype.open = function (method, url) {
      try { this.__sniff = { method: method, url: url, time: Date.now() }; } catch (e) {}
      return origOpen.apply(this, arguments);
    };
    XMLHttpRequest.prototype.send = function (body) {
      var s = this.__sniff || { method: '?', url: '?', time: Date.now() };
      var reqBody = '';
      try { reqBody = bodyToText(body); } catch (e) {}
      var fullUrl = absUrl(s.url);
      try {
        this.addEventListener('loadend', function () {
          var resp = '';
          try { resp = this.responseText || ''; }
          catch (e) { resp = '[binary]'; }
          send({ kind: 'http', method: s.method, url: fullUrl, status: this.status,
                 reqBody: trunc(reqBody), respBody: trunc(resp), time: s.time });
        });
      } catch (e) { /* ignore */ }
      return origSend.apply(this, arguments);
    };
  } catch (e) { /* ignore */ }

  /* ---------- sendBeacon ---------- */
  try {
    if (navigator.sendBeacon) {
      var origBeacon = navigator.sendBeacon.bind(navigator);
      navigator.sendBeacon = function (url, data) {
        send({ kind: 'beacon', method: 'POST', url: absUrl(String(url)), status: 0,
               reqBody: trunc(bodyToText(data)), respBody: '', time: Date.now() });
        return origBeacon(url, data);
      };
    }
  } catch (e) { /* ignore */ }
})();
