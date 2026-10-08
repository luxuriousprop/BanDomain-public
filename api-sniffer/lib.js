'use strict';
/* 纯函数库：popup 与 background 共用，浏览器 / Node 通用 */
(function (root) {

  function parseUrlParts(url) {
    try {
      var u = new URL(url);
      return { host: u.host, path: u.pathname, query: u.search };
    } catch (e) {
      return { host: '', path: String(url), query: '' };
    }
  }

  function groupKeyFor(method, url) {
    var p = parseUrlParts(url);
    return String(method || '?').toUpperCase() + ' ' + p.path;
  }

  var STATIC_EXT = /\.(js|css|png|jpe?g|gif|svg|ico|webp|woff2?|ttf|eot|map|mp4|mp3)(\?|#|$)/i;

  /* 启发式判断一条记录是不是 API 调用 */
  function looksLikeApi(path, respSample) {
    var p = String(path || '').toLowerCase();
    if (STATIC_EXT.test(p)) return false;
    if (p.indexOf('/api/') !== -1 || p.indexOf('/apis/') !== -1) return true;
    if (/\/v\d+(\/|$)/.test(p)) return true;
    if (p.indexOf('/graphql') !== -1 || p.indexOf('/rest/') !== -1) return true;
    if (/\.(do|action|json|php|asp|aspx)(\?|#|$)/.test(p)) return true;
    if (respSample && isJsonLike(respSample)) return true;
    return false;
  }

  function isJsonLike(t) {
    if (!t) return false;
    var s = t.trim();
    if (!s) return false;
    var c = s.charAt(0);
    if (c !== '{' && c !== '[') return false;
    try { JSON.parse(s); return true; } catch (e) { return false; }
  }

  function tryPrettyJson(text) {
    try {
      var j = JSON.parse(text);
      return { ok: true, pretty: JSON.stringify(j, null, 2) };
    } catch (e) {
      return { ok: false, pretty: String(text) };
    }
  }

  function shellQuote(s) {
    return "'" + String(s).replace(/'/g, "'\\''") + "'";
  }

  /* 根据一条记录生成 curl 命令 */
  function buildCurl(method, url, body) {
    var m = String(method || 'GET').toUpperCase();
    var parts = ['curl', '-X', m, shellQuote(url)];
    if (body) {
      parts.push('--data-raw', shellQuote(body));
      var t = body.trim();
      if (t.charAt(0) === '{') parts.push('-H', shellQuote('Content-Type: application/json'));
    }
    return parts.join(' ');
  }

  /* 导出 Markdown 表格 */
  function toMarkdown(groups) {
    var lines = ['| 方法 | 路径 | 调用次数 | 状态码 |', '|---|---|---|---|'];
    groups.forEach(function (g) {
      var statuses = Object.keys(g.statuses || {}).join(',');
      lines.push('| ' + g.method + ' | `' + g.path + '` | ' + g.count + ' | ' + (statuses || '-') + ' |');
    });
    return lines.join('\n') + '\n';
  }

  root.ApiLib = {
    parseUrlParts: parseUrlParts,
    groupKeyFor: groupKeyFor,
    looksLikeApi: looksLikeApi,
    isJsonLike: isJsonLike,
    tryPrettyJson: tryPrettyJson,
    buildCurl: buildCurl,
    toMarkdown: toMarkdown
  };
})(typeof window !== 'undefined' ? window : globalThis);
