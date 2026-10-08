'use strict';
/* ISOLATED world：接收 page-hook 的 postMessage，转交给 background；
   另提供「静态扫描 JS」「探测 OpenAPI」两个按需功能 */

window.addEventListener('message', function (event) {
  if (event.source !== window) return;
  var d = event.data;
  if (!d || d.__apiSniffer !== true) return;
  chrome.runtime.sendMessage({
    type: 'api-record',
    record: {
      kind: d.kind, method: d.method, url: d.url, status: d.status,
      reqBody: d.reqBody || '', respBody: d.respBody || '',
      time: d.time || Date.now(), error: d.error || ''
    }
  }).catch(function () { /* background 可能尚未就绪 */ });
});

chrome.runtime.onMessage.addListener(function (msg, sender, sendResponse) {
  if (msg.type === 'scan-scripts') {
    scanScripts().then(function (r) { sendResponse({ ok: true, result: r }); })
      .catch(function (e) { sendResponse({ ok: false, error: String(e && e.message || e) }); });
    return true;
  }
  if (msg.type === 'probe-openapi') {
    probeOpenAPI().then(function (r) { sendResponse({ ok: true, result: r }); })
      .catch(function (e) { sendResponse({ ok: false, error: String(e && e.message || e) }); });
    return true;
  }
});

/* 抓取本页引用的 JS（含内联），用正则提取疑似接口路径 */
async function scanScripts() {
  var urls = new Set();
  document.querySelectorAll('script[src]').forEach(function (s) {
    try { urls.add(new URL(s.src, location.href).href); } catch (e) {}
  });
  var texts = [];
  document.querySelectorAll('script:not([src])').forEach(function (s) {
    if (s.textContent && s.textContent.length < 500000) texts.push({ file: '<inline>', text: s.textContent });
  });
  var list = Array.from(urls).slice(0, 25);
  for (var i = 0; i < list.length; i++) {
    try {
      var resp = await fetch(list[i]);
      if (!resp.ok) continue;
      var t = await resp.text();
      if (t.length > 3000000) continue;
      texts.push({ file: list[i], text: t });
    } catch (e) { /* 跨域或失败就跳过 */ }
  }
  var found = new Map();
  var re = /["'`](\/[A-Za-z0-9_\-\.\{\}]+(?:\/[A-Za-z0-9_\-\.\{\}]+)+)["'`]/g;
  for (var k = 0; k < texts.length; k++) {
    var file = texts[k].file, text = texts[k].text, m;
    re.lastIndex = 0;
    while ((m = re.exec(text)) !== null) {
      var p = m[1];
      if (p.length > 150 || !/[a-zA-Z]/.test(p)) continue;
      if (!found.has(p)) found.set(p, file);
      if (found.size >= 500) break;
    }
    if (found.size >= 500) break;
  }
  return Array.from(found.entries()).map(function (e) { return { path: e[0], file: e[1] }; });
}

/* 探测同源下的 OpenAPI / Swagger 文档 */
async function probeOpenAPI() {
  var origin = location.origin;
  var cands = ['/openapi.json', '/swagger.json', '/v3/api-docs', '/api-docs', '/swagger/v1/swagger.json'];
  for (var i = 0; i < cands.length; i++) {
    try {
      var resp = await fetch(origin + cands[i]);
      if (!resp.ok) continue;
      var j = await resp.json();
      if (j && (j.openapi || j.swagger)) {
        return { found: true, url: origin + cands[i],
                 title: (j.info && j.info.title) || '', version: (j.info && j.info.version) || '' };
      }
    } catch (e) { /* 不是 JSON 就继续 */ }
  }
  return { found: false };
}
