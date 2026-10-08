'use strict';
/* 弹窗逻辑：读取本 tab 的抓包记录并展示 */

var state = {
  tabId: null,
  tabUrl: '',
  recording: true,
  groups: [],
  filter: '',
  apiOnly: true,
  selected: null,
  staticList: null
};

function $(id) { return document.getElementById(id); }

function esc(s) {
  return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;');
}

function fullUrl(g, qi) {
  var q = (qi != null ? g.queries[qi] : g.queries[0]) || '';
  return 'https://' + g.host + g.path + q;
}

function visibleGroups() {
  var f = state.filter.trim().toLowerCase();
  return state.groups.filter(function (g) {
    if (state.apiOnly && !ApiLib.looksLikeApi(g.path, g.respSample)) return false;
    if (f && (g.method + ' ' + g.path).toLowerCase().indexOf(f) === -1) return false;
    return true;
  });
}

function renderList() {
  var box = $('list');
  var groups = visibleGroups();
  box.innerHTML = '';
  if (!groups.length) {
    box.innerHTML = '<div class="empty">' +
      (state.groups.length ? '没有匹配的记录，换个过滤条件试试' : '还没有抓到请求<br>去页面上操作一下，或点「↻ 刷新重抓」') + '</div>';
    return;
  }
  groups.forEach(function (g) {
    var row = document.createElement('div');
    row.className = 'row' + (state.selected === g.key ? ' selected' : '');
    var statuses = Object.keys(g.statuses || {}).join(',');
    row.innerHTML =
      '<span class="method ' + esc(g.method) + '">' + esc(g.method) + '</span>' +
      '<span class="path">' + esc(g.path) + '</span>' +
      '<span class="count">×' + g.count + (statuses ? ' · ' + esc(statuses) : '') + '</span>';
    row.addEventListener('click', function () { selectGroup(g.key); });
    box.appendChild(row);
  });
}

function selectGroup(key) {
  state.selected = key;
  var g = null;
  state.groups.forEach(function (x) { if (x.key === key) g = x; });
  renderList();
  if (!g) { $('detail').style.display = 'none'; return; }

  $('detail').style.display = 'block';
  $('detailTitle').textContent = g.method + ' ' + g.path;
  var statuses = Object.keys(g.statuses || {}).map(function (s) { return s + '×' + g.statuses[s]; }).join(' ');
  $('detailMeta').textContent =
    g.host + '  ·  调用 ' + g.count + ' 次' + (statuses ? '  ·  状态码 ' + statuses : '');

  var reqParts = [];
  g.queries.forEach(function (q, i) { reqParts.push('query[' + i + ']: ' + q); });
  g.reqBodies.forEach(function (b, i) { reqParts.push('body[' + i + ']:\n' + b); });
  $('detailReq').textContent = reqParts.length ? reqParts.join('\n\n') : '(无参数样本)';

  if (g.respSample) {
    var p = ApiLib.tryPrettyJson(g.respSample);
    $('detailResp').textContent = p.pretty;
  } else {
    $('detailResp').textContent = '(无响应样本)';
  }
  $('detail').scrollIntoView({ block: 'nearest' });
}

function copyText(text, btn) {
  function done() {
    if (btn) {
      var old = btn.textContent;
      btn.textContent = '已复制 ✓';
      setTimeout(function () { btn.textContent = old; }, 1200);
    }
  }
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(text).then(done).catch(function () { fallback(); done(); });
  } else { fallback(); done(); }
  function fallback() {
    var ta = document.createElement('textarea');
    ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0';
    document.body.appendChild(ta); ta.select();
    try { document.execCommand('copy'); } catch (e) {}
    ta.remove();
  }
}

function download(name, text, mime) {
  var blob = new Blob([text], { type: mime || 'text/plain;charset=utf-8' });
  var a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(function () { URL.revokeObjectURL(a.href); }, 2000);
}

function refreshRecordBtn() {
  var b = $('btnRecord');
  b.textContent = state.recording ? '⏸ 暂停抓取' : '▶ 开始抓取';
  b.classList.toggle('off', !state.recording);
}

function loadTabData() {
  chrome.runtime.sendMessage({ type: 'get-tab-data', tabId: state.tabId }, function (res) {
    if (!res || !res.ok) return;
    state.recording = res.recording;
    state.groups = res.groups || [];
    refreshRecordBtn();
    renderList();
    if (state.selected) selectGroup(state.selected);
  });
}

function renderStatic() {
  var box = $('staticBox'), list = $('staticList');
  if (!state.staticList) { box.style.display = 'none'; return; }
  box.style.display = 'block';
  list.innerHTML = '';
  var paths = {};
  state.groups.forEach(function (g) { paths[g.path] = true; });
  if (!state.staticList.length) {
    list.innerHTML = '<div class="empty">JS 里没扫到疑似接口路径</div>';
    return;
  }
  state.staticList.forEach(function (it) {
    var div = document.createElement('div');
    div.className = 'item';
    var hit = !!paths[it.path];
    div.innerHTML = (hit ? '<span class="hit">✓ </span>' : '<span>· </span>') +
      esc(it.path) + '<span class="src">' + esc(it.file) + '</span>';
    list.appendChild(div);
  });
}

document.addEventListener('DOMContentLoaded', function () {
  chrome.tabs.query({ active: true, currentWindow: true }, function (tabs) {
    var tab = tabs && tabs[0];
    if (!tab) { $('tabInfo').textContent = '取不到当前标签页'; return; }
    state.tabId = tab.id;
    state.tabUrl = tab.url || '';
    $('tabInfo').textContent = state.tabUrl;
    loadTabData();
  });

  // 每 2 秒刷新一次列表（抓包是持续的）
  setInterval(function () { if (state.tabId != null) loadTabData(); }, 2000);

  $('btnRecord').addEventListener('click', function () {
    chrome.runtime.sendMessage({ type: 'toggle-recording' }, function (res) {
      if (res && res.ok) { state.recording = res.recording; refreshRecordBtn(); }
    });
  });

  $('btnReload').addEventListener('click', function () {
    if (state.tabId == null) return;
    chrome.runtime.sendMessage({ type: 'clear-tab', tabId: state.tabId }, function () {
      chrome.tabs.reload(state.tabId);
      setTimeout(loadTabData, 800);
    });
  });

  $('btnClear').addEventListener('click', function () {
    if (state.tabId == null) return;
    chrome.runtime.sendMessage({ type: 'clear-tab', tabId: state.tabId }, function () {
      state.selected = null;
      $('detail').style.display = 'none';
      loadTabData();
    });
  });

  $('filter').addEventListener('input', function (e) {
    state.filter = e.target.value;
    renderList();
  });

  $('apiOnly').addEventListener('change', function (e) {
    state.apiOnly = e.target.checked;
    renderList();
  });

  $('detailClose').addEventListener('click', function () {
    state.selected = null;
    $('detail').style.display = 'none';
    renderList();
  });

  $('btnCurl').addEventListener('click', function (e) {
    var g = null;
    state.groups.forEach(function (x) { if (x.key === state.selected) g = x; });
    if (!g) return;
    var url = 'https://' + g.host + g.path + (g.queries[0] || '');
    var body = g.reqBodies[0] || '';
    copyText(ApiLib.buildCurl(g.method, url, body), e.target);
  });

  $('btnCopyUrl').addEventListener('click', function (e) {
    var g = null;
    state.groups.forEach(function (x) { if (x.key === state.selected) g = x; });
    if (!g) return;
    copyText('https://' + g.host + g.path, e.target);
  });

  $('btnExportJson').addEventListener('click', function () {
    download('api-list.json', JSON.stringify(state.groups, null, 2), 'application/json');
  });

  $('btnExportMd').addEventListener('click', function () {
    download('api-list.md', '# API 入口清单\n\n来源：' + state.tabUrl + '\n\n' + ApiLib.toMarkdown(visibleGroups()));
  });

  $('btnScan').addEventListener('click', function (e) {
    var btn = e.target;
    btn.disabled = true; btn.textContent = '扫描中…';
    chrome.tabs.sendMessage(state.tabId, { type: 'scan-scripts' }, function (res) {
      btn.disabled = false; btn.textContent = '🔍 扫描 JS 找接口';
      if (!res) { alert('此页面无法注入脚本（如 chrome:// 内置页），换目标网站试试'); return; }
      if (!res.ok) { alert('扫描失败：' + res.error); return; }
      state.staticList = res.result;
      renderStatic();
    });
  });

  $('btnProbe').addEventListener('click', function (e) {
    var btn = e.target;
    btn.disabled = true; btn.textContent = '探测中…';
    chrome.tabs.sendMessage(state.tabId, { type: 'probe-openapi' }, function (res) {
      btn.disabled = false; btn.textContent = '📄 探测 OpenAPI 文档';
      var box = $('probeResult');
      if (!res) { box.textContent = '此页面无法注入脚本，换目标网站试试'; return; }
      if (!res.ok) { box.textContent = '探测失败：' + res.error; return; }
      var r = res.result;
      if (r.found) {
        box.innerHTML = '发现 OpenAPI 文档：<a href="' + esc(r.url) + '" target="_blank">' +
          esc(r.url) + '</a>' + (r.title ? '（' + esc(r.title) + ' ' + esc(r.version) + '）' : '') +
          ' —— 可直接导入 Postman / Apifox';
      } else {
        box.textContent = '未发现 OpenAPI / Swagger 文档（试过 /openapi.json 等 5 个常见路径）';
      }
    });
  });
});
