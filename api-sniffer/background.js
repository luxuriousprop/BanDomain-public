'use strict';
/* Service Worker：按 tab 聚合 API 记录，供 popup 读取 */
importScripts('lib.js');

var tabData = new Map(); // tabId -> {groups: Map(key->group), order: [key]}
var recording = true;
var MAX_GROUPS = 1000;

function getTab(tabId) {
  var t = tabData.get(tabId);
  if (!t) { t = { groups: new Map(), order: [] }; tabData.set(tabId, t); }
  return t;
}

function addRecord(tabId, r) {
  if (!r || !r.url) return;
  var t = getTab(tabId);
  var parts = ApiLib.parseUrlParts(r.url);
  var key = ApiLib.groupKeyFor(r.method, r.url);
  var g = t.groups.get(key);
  if (!g) {
    g = {
      key: key, method: String(r.method || '?').toUpperCase(),
      host: parts.host, path: parts.path,
      count: 0, statuses: {}, firstSeen: r.time || Date.now(), lastSeen: 0,
      queries: [], reqBodies: [], respSample: '', respStatus: 0
    };
    t.groups.set(key, g);
    t.order.push(key);
    if (t.order.length > MAX_GROUPS) {
      var old = t.order.shift();
      t.groups.delete(old);
    }
  }
  g.count++;
  g.lastSeen = r.time || Date.now();
  if (r.status) g.statuses[r.status] = (g.statuses[r.status] || 0) + 1;
  if (parts.query && g.queries.indexOf(parts.query) === -1 && g.queries.length < 5) {
    g.queries.push(parts.query);
  }
  if (r.reqBody && g.reqBodies.indexOf(r.reqBody) === -1 && g.reqBodies.length < 3) {
    g.reqBodies.push(r.reqBody);
  }
  if (r.respBody && !g.respSample) {
    g.respSample = r.respBody;
    g.respStatus = r.status || 0;
  }
}

function updateBadge(tabId) {
  try {
    var t = tabData.get(tabId);
    var n = t ? t.groups.size : 0;
    chrome.action.setBadgeText({ text: n > 0 ? String(n) : '', tabId: tabId });
    chrome.action.setBadgeBackgroundColor({ color: '#2563eb', tabId: tabId });
  } catch (e) { /* ignore */ }
}

chrome.runtime.onMessage.addListener(function (msg, sender, sendResponse) {
  if (msg.type === 'api-record') {
    if (recording && sender.tab && sender.tab.id != null) {
      addRecord(sender.tab.id, msg.record);
      updateBadge(sender.tab.id);
    }
    return;
  }
  if (msg.type === 'get-tab-data') {
    var t = tabData.get(msg.tabId);
    var groups = t ? t.order.map(function (k) { return t.groups.get(k); }) : [];
    sendResponse({ ok: true, recording: recording, groups: groups });
    return;
  }
  if (msg.type === 'toggle-recording') {
    recording = !recording;
    sendResponse({ ok: true, recording: recording });
    return;
  }
  if (msg.type === 'clear-tab') {
    tabData.delete(msg.tabId);
    updateBadge(msg.tabId);
    sendResponse({ ok: true });
    return;
  }
});

chrome.tabs.onRemoved.addListener(function (tabId) {
  tabData.delete(tabId);
});
