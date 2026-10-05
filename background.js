// background.js — MV3 Service Worker：浏览器右键菜单"封禁该 IP 的上网用户"
// 流程：右键选中 IP 文本/链接 -> 提取 IP -> 后台先查 SAM queryOnlineUser ->
//   有结果 -> 屏幕中央弹出封禁确认窗口(ban.html)；无结果 -> 系统通知提示。

importScripts("sam-api.js");

const MENU_ID = "bandomain-ban-ip-user";
const BAN_WIN_W = 400;
const BAN_WIN_H = 540;

function createContextMenu() {
  // Service Worker 可能被回收，按官方最佳实践在安装与启动时重建菜单
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({
      id: MENU_ID,
      title: "🚫 封禁该 IP 的上网用户",
      contexts: ["selection", "link"]
    });
  });
}

chrome.runtime.onInstalled.addListener(createContextMenu);
chrome.runtime.onStartup.addListener(createContextMenu);

chrome.contextMenus.onClicked.addListener((info) => {
  if (info.menuItemId !== MENU_ID) return;
  // 保持 Service Worker 在异步流程完成前存活
  handleBanMenuClick(info).catch((err) => {
    showNotification("操作失败", err && err.message ? err.message : String(err));
  });
});

async function handleBanMenuClick(info) {
  const found = extractIpFromMenu(info);
  if (!found) {
    showNotification("未找到 IP 地址", "请先选中一段包含 IP 的文本，或在 IP 链接上右击。");
    return;
  }
  const { ip, dirtySelection } = found;

  let samList;
  try {
    samList = await getSamConfigs();
  } catch (err) {
    showNotification("尚未配置", "请先打开插件弹窗，在设置中配置 SAM 接口地址、用户名与密码。");
    return;
  }

  let results;
  try {
    ({ results } = await queryOnlineUsersMulti(samList, ip));
  } catch (err) {
    const msg = err.name === "AbortError" ? "连接超时：10 秒内未收到 SAM 响应" : err.message;
    showNotification("查询失败", msg);
    return;
  }

  const hit = results.find((r) => r.users.length > 0);
  if (!hit) {
    showNotification("查询无结果", "该用户不在SAM中，请手动封禁");
    return;
  }

  const key = "banPending_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  // 同一时刻一个 IP 只会有一条在线记录；封禁打到查出记录的同一台 SAM
  const sam = hit.sam;
  await chrome.storage.session.set({
    [key]: { user: hit.users[0], ip, samUrl: sam.url, authHeader: sam.authHeader, samName: sam.name, dirtySelection: dirtySelection || null }
  });
  const rect = await centeredWindowRect(BAN_WIN_W, BAN_WIN_H);
  await chrome.windows.create({
    url: chrome.runtime.getURL("ban.html") + "?key=" + encodeURIComponent(key),
    type: "popup",
    ...rect
  });
}

// 从右键菜单信息中提取 IP：选中文本优先，其次链接地址；IPv4/IPv6 均支持。
// 返回 { ip, dirtySelection }：dirtySelection 为 null 表示选中内容干净（仅 IP 本身，
// 允许首尾空白）；否则为清洗前的原文（截断），调用方据此提示用户核对。
function extractIpFromMenu(info) {
  const sel = info.selectionText ? String(info.selectionText) : "";
  if (sel) {
    const v4 = sel.match(/\b(?:\d{1,3}\.){3}\d{1,3}\b/);
    if (v4 && isValidIp(v4[0])) {
      return { ip: v4[0], dirtySelection: dirtyOf(sel, v4[0], v4.index) };
    }
    const v6 = sel.match(/\b(?:[0-9a-fA-F]{0,4}:){2,}[0-9a-fA-F:.]+\b/);
    if (v6 && isIpv6(v6[0])) {
      return { ip: v6[0], dirtySelection: dirtyOf(sel, v6[0], v6.index) };
    }
    return null;
  }
  if (info.linkUrl) {
    const s = String(info.linkUrl);
    const v4 = s.match(/\b(?:\d{1,3}\.){3}\d{1,3}\b/);
    if (v4 && isValidIp(v4[0])) return { ip: v4[0], dirtySelection: null };
    const v6 = s.match(/\b(?:[0-9a-fA-F]{0,4}:){2,}[0-9a-fA-F:.]+\b/);
    if (v6 && isIpv6(v6[0])) return { ip: v6[0], dirtySelection: null };
  }
  return null;
}

// 脏选中检测：去掉命中的 IP 后，若剩余内容还有数字/字母/中文，视为多选了多余字符
function dirtyOf(text, ip, index) {
  const rest = (text.slice(0, index) + text.slice(index + ip.length)).trim();
  if (!rest) return null;
  return /[0-9a-zA-Z\u4e00-\u9fa5]/.test(rest) ? truncateSelection(text) : null;
}

function truncateSelection(text) {
  const t = String(text).trim().replace(/\s+/g, " ");
  return t.length > 40 ? t.slice(0, 40) + "…" : t;
}

function showNotification(title, message) {
  chrome.notifications.create({
    type: "basic",
    iconUrl: "icon48.png",
    title: "网络运维工具 · " + title,
    message: String(message)
  });
}

// 屏幕中央矩形 + 分辨率自适应：取主显示器工作区，窗口不超过工作区并居中；
// 取不到显示器信息时退化为浏览器默认落点。
async function centeredWindowRect(w, h) {
  let area = null;
  try {
    const displays = await chrome.system.display.getInfo();
    const primary = displays.find((d) => d.isPrimary) || displays[0];
    area = primary && primary.workArea;
  } catch (e) { /* 忽略，退化处理 */ }
  if (!area) return { width: w, height: h };
  const width = Math.min(w, Math.max(200, area.width - 40));
  const height = Math.min(h, Math.max(200, area.height - 40));
  return {
    width,
    height,
    left: Math.round(area.left + (area.width - width) / 2),
    top: Math.round(area.top + (area.height - height) / 2)
  };
}
