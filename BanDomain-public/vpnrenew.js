// VPN 用户续期独立窗口（v1.12 起从主面板"更多"菜单进入）
// v1.13.6 起：parent_group 改回下拉框选择（UpdateUserCloud 会把用户挪到该组，传 / 会误挪到根目录）
// 实测确认：不调 5.1 生效接口变更也直接生效，故无"立即生效"按钮
"use strict";

const $ = (id) => document.getElementById(id);
const nameEl = $("rnName"), groupEl = $("rnGroup"), exTimeEl = $("rnExTime");
const confirmBtn = $("confirmBtn");
const cancelBtn = $("cancelBtn"), closeBtn = $("closeBtn");
const userInfoBox = $("userInfoBox");
const msgEl = $("msg");

function setMsg(text, isError) {
  msgEl.textContent = text;
  msgEl.style.color = isError ? "#b71c1c" : "#2e7d32";
}

let vpnBase = "", vpnSkey = "", vpnGroups = [];
let armed = false;

function disarm() {
  armed = false;
  confirmBtn.textContent = "确认续期";
  confirmBtn.classList.remove("confirming");
}

// Unix 秒时间戳 → YYYY-MM-DD（0/空表示未设置）
function fmtDate(ts) {
  const n = Number(ts);
  if (!n) return "未设置";
  const d = new Date(n * 1000);
  const p = (x) => String(x).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}
function fmtDateTime(ts) {
  const n = Number(ts);
  if (!n) return "未设置";
  const d = new Date(n * 1000);
  const p = (x) => String(x).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

// 回显该用户"编辑用户"接口的相关参数（供续期前核对）
function renderUserInfo(info) {
  const lines = [];
  lines.push(`用户名：${info.name || "-"}`);
  lines.push(`用户描述：${info.note || "-"}`);
  lines.push(`手机号：${info.phone || "-"}`);
  const grpid = info.grpid;
  lines.push(`所属组 id：${grpid || "-"}${String(grpid) === "-1" ? "（无有效组）" : ""}`);
  lines.push(`当前过期时间：${fmtDate(info.expire)}`);
  lines.push(`最近登录：${fmtDateTime(info.lastlogin_time)}`);
  userInfoBox.textContent = lines.join("\n");
  userInfoBox.style.display = "block";
}

async function init() {
  const params = new URLSearchParams(location.search);
  const key = params.get("key");
  if (!key) {
    setMsg("⛔ 缺少窗口参数，请从插件主面板的「更多 → 用户续期」重新进入。", true);
    confirmBtn.disabled = true;
    return;
  }
  let data;
  try {
    const stored = await chrome.storage.session.get(key);
    data = stored[key];
    await chrome.storage.session.remove(key);
  } catch (err) {
    setMsg("⛔ 读取配置失败：" + err.message, true);
    confirmBtn.disabled = true;
    return;
  }
  if (!data || !data.vpnBase || !data.vpnSkey) {
    setMsg("⛔ 配置无效，请从插件主面板重新进入。", true);
    confirmBtn.disabled = true;
    return;
  }
  vpnBase = data.vpnBase;
  vpnSkey = data.vpnSkey;
  vpnGroups = (data.vpnGroups || []).map(normalizeVpnGroup).filter(Boolean);
  groupEl.innerHTML = "";
  for (const g of vpnGroups) {
    const opt = document.createElement("option");
    opt.value = g;
    opt.textContent = g;
    groupEl.appendChild(opt);
  }
  if (!vpnGroups.length) {
    setMsg("⛔ 未配置任何用户组，请先在设置中填写 VPN 用户组。", true);
    confirmBtn.disabled = true;
    return;
  }
  // 默认选中 /默认用户组（无则回退到第一个）
  // 注意：UpdateUserCloud 的 parent_group 会把用户挪到该组，务必选对
  const defGroup = vpnGroups.includes("/默认用户组") ? "/默认用户组" : vpnGroups[0];
  if (defGroup) groupEl.value = defGroup;
}

cancelBtn.addEventListener("click", () => window.close());
closeBtn.addEventListener("click", () => window.close());

confirmBtn.addEventListener("click", async () => {
  const username = nameEl.value.trim();
  const exTime = exTimeEl.value; // date input 直接给出 YYYY-MM-DD
  if (!username) {
    setMsg("⛔ 用户名不能为空", true);
    return;
  }
  if (!exTime) {
    setMsg("⛔ 请选择新的过期日期", true);
    return;
  }
  const today = new Date().toISOString().slice(0, 10);
  if (exTime < today) {
    setMsg("⛔ 过期日期不能早于今天", true);
    return;
  }
  if (!armed) {
    // 第一下：拉取该用户"编辑用户"相关参数并回显，核对无误后再点第二下
    confirmBtn.disabled = true;
    setMsg(`正在加载 ${username} 的用户信息…`, false);
    try {
      const info = await vpnGetUserInfo(vpnBase, vpnSkey, username);
      if (!info || !info.name) throw new Error("用户不存在");
      renderUserInfo(info);
      armed = true;
      confirmBtn.textContent = "再次确认续期？";
      confirmBtn.classList.add("confirming");
      setMsg(`请核对上方用户信息，确认将 ${username} 的过期时间设为 ${exTime}（所属组：${groupEl.value}）`, false);
    } catch (err) {
      setMsg("✖ " + err.message, true);
    } finally {
      confirmBtn.disabled = false;
    }
    return;
  }
  disarm();
  confirmBtn.disabled = true;
  cancelBtn.disabled = true;
  setMsg(`正在为 ${username} 续期…`, false);
  try {
    await vpnRenewUser(vpnBase, vpnSkey, username, groupEl.value, exTime);
    setMsg(`✔ VPN 用户 ${username} 续期成功，新的过期时间：${exTime}`, false);
    confirmBtn.style.display = "none";
    cancelBtn.style.display = "none";
    closeBtn.style.display = "block";
  } catch (err) {
    setMsg("✖ 续期失败：" + err.message, true);
    confirmBtn.disabled = false;
    cancelBtn.disabled = false;
  }
});

init();
