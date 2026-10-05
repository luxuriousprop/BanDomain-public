// vpnban.js — VPN 封禁确认窗口逻辑（与 vpnban.html 配套，依赖 vpn-api.js）
// 待封禁用户经 chrome.storage.session 一次性传递（popup 失焦即关闭，不能放内存变量）

const userInfoBox = document.getElementById("userInfo");
const confirmBtn = document.getElementById("confirmBtn");
const cancelBtn = document.getElementById("cancelBtn");
const closeBtn = document.getElementById("closeBtn");
const msgBox = document.getElementById("msg");

function showMsg(text, isError) {
  msgBox.style.color = isError ? "#b71c1c" : "#1b5e20";
  msgBox.textContent = text;
}

function getPendingKey() {
  return new URLSearchParams(location.search).get("key");
}

async function init() {
  const key = getPendingKey();
  let pending = null;
  try {
    pending = (await chrome.storage.session.get([key]))[key];
    await chrome.storage.session.remove([key]); // 一次性读取后即清理
  } catch (err) {
    showMsg("⛔ 读取待封禁信息失败：" + err.message, true);
    confirmBtn.disabled = true;
    return;
  }

  if (!pending || !pending.user || !(pending.user.name || "").trim() ||
      !pending.vpnBase || !pending.vpnSkey) {
    userInfoBox.textContent = "（无用户信息）";
    showMsg("⛔ 会话已过期或信息缺失，请关闭本窗口后重新查询再操作。", true);
    confirmBtn.disabled = true;
    return;
  }

  const { user, ip, group, vpnBase, vpnSkey } = pending;
  const username = (user.name || "").trim();

  // 点击封禁后，先调查询用户接口（5.2.1）拿最新信息再展示，
  // 不再只显示在线列表里的数据
  renderOnlineInfo(user, ip, group);
  userInfoBox.textContent += "\n正在获取用户最新信息…";
  confirmBtn.disabled = true;
  try {
    const info = await vpnGetUserInfo(vpnBase, vpnSkey, username);
    renderFreshInfo(info, user, ip, group);
  } catch (err) {
    renderOnlineInfo(user, ip, group);
    userInfoBox.textContent += `\n⚠️ 用户最新信息获取失败：${err.message}（以下显示在线列表数据）`;
  } finally {
    confirmBtn.disabled = false;
  }

  confirmBtn.addEventListener("click", () => doVpnBan(user, vpnBase, vpnSkey));
  cancelBtn.addEventListener("click", () => window.close());
  closeBtn.addEventListener("click", () => window.close());
}

// 在线列表数据兜底展示（查询用户接口失败时用）
function renderOnlineInfo(user, ip, group) {
  // XSS 安全：只用 textContent
  const lines = [];
  if (user.name) lines.push(`用户名：${user.name}`);
  if (user.nip) lines.push(`来访 IP：${user.nip}`);
  if (user.vip && user.vip !== "0.0.0.0") lines.push(`虚拟 IP：${user.vip}`);
  if (user.login_time) lines.push(`登录时间：${user.login_time}`);
  if (user.grp) lines.push(`用户组：${user.grp}`);
  lines.push(`所属查询组：${group || "—"}`);
  lines.push(`来源 IP：${ip || "—"}`);
  userInfoBox.textContent = lines.join("\n");
}

function formatVpnEpoch(ts) {
  const n = parseInt(ts, 10);
  if (!n) return "—";
  return new Date(n * 1000).toLocaleString("zh-CN", { hour12: false });
}

// 查询用户接口（5.2.1）返回的最新信息展示，叠加在线会话的 IP
function renderFreshInfo(info, onlineUser, ip, group) {
  // XSS 安全：只用 textContent
  const lines = [];
  lines.push(`用户名：${info.name || onlineUser.name || "—"}`);
  if (info.note) lines.push(`用户描述：${info.note}`);
  if (info.parent_path) lines.push(`所属组：${info.parent_path}`);
  if (info.phone) lines.push(`手机号：${info.phone}`);
  if (info.is_enable !== undefined && info.is_enable !== "" && info.is_enable !== null) {
    lines.push(`账号状态：${String(info.is_enable) === "1" ? "启用" : "禁用"}`);
  }
  if (info.lastlogin_time) lines.push(`最近登录：${formatVpnEpoch(info.lastlogin_time)}`);
  if (onlineUser.nip) lines.push(`来访 IP：${onlineUser.nip}`);
  if (onlineUser.vip && onlineUser.vip !== "0.0.0.0") lines.push(`虚拟 IP：${onlineUser.vip}`);
  lines.push(`所属查询组：${group || "—"}`);
  lines.push(`来源 IP：${ip || "—"}`);
  userInfoBox.textContent = lines.join("\n");
}

async function doVpnBan(user, vpnBase, vpnSkey) {
  const username = (user.name || "").trim();
  if (!username) {
    showMsg("⛔ 用户名缺失，无法封禁", true);
    return;
  }

  confirmBtn.disabled = true;
  cancelBtn.disabled = true;
  showMsg("正在禁用用户并断开其 VPN 会话…", false);
  msgBox.style.color = "#0d47a1";

  try {
    const { killWarning } = await vpnBanUser(vpnBase, vpnSkey, username);
    let msg = `✔ 已禁用 VPN 用户 ${username}，其当前在线会话已断开，该用户将无法再登录 VPN。`;
    if (killWarning) msg += `\n（${killWarning}）`;
    msg += "\n恢复需在 VPN 控制台手动重新启用该用户。";
    showMsg(msg, false);
    confirmBtn.style.display = "none";
    cancelBtn.style.display = "none";
    closeBtn.style.display = "block";
  } catch (err) {
    confirmBtn.disabled = false;
    cancelBtn.disabled = false;
    showMsg("✖ 封禁失败：" + err.message, true);
  }
}

document.addEventListener("DOMContentLoaded", init);
