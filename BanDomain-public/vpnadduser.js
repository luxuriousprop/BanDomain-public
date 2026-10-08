// 新建 VPN 用户独立窗口（v1.11 起从主面板"更多"菜单进入）
// 配置经 chrome.storage.session 一次性传递（popup 关闭后内存不可用）
"use strict";

const $ = (id) => document.getElementById(id);
const nameEl = $("auName"), groupEl = $("auGroup"), passwdEl = $("auPasswd"), exTimeEl = $("auExTime");
const phoneEl = $("auPhone"), noteEl = $("auNote");
const confirmBtn = $("confirmBtn"), cancelBtn = $("cancelBtn"), closeBtn = $("closeBtn");
const msgEl = $("msg");

function setMsg(text, isError) {
  msgEl.textContent = text;
  msgEl.style.color = isError ? "#b71c1c" : "#2e7d32";
}

let vpnBase = "", vpnSkey = "", vpnGroups = [];
let armed = false;

function disarm() {
  armed = false;
  confirmBtn.textContent = "确认新建";
  confirmBtn.classList.remove("confirming");
}

async function init() {
  const params = new URLSearchParams(location.search);
  const key = params.get("key");
  if (!key) {
    setMsg("⛔ 缺少窗口参数，请从插件主面板的「更多 → 新建用户」重新进入。", true);
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
  }
  // 默认选中 /默认用户组（无则回退到第一个）
  const defGroup = vpnGroups.includes("/默认用户组") ? "/默认用户组" : vpnGroups[0];
  if (defGroup) groupEl.value = defGroup;
}

cancelBtn.addEventListener("click", () => window.close());
closeBtn.addEventListener("click", () => window.close());

confirmBtn.addEventListener("click", async () => {
  const name = nameEl.value.trim();
  const passwd = passwdEl.value;
  const exTime = exTimeEl.value; // date input 直接给出 YYYY-MM-DD
  if (!name) {
    setMsg("⛔ 用户名不能为空", true);
    return;
  }
  if (!passwd) {
    setMsg("⛔ 密码为必填项", true);
    return;
  }
  if (!exTime) {
    setMsg("⛔ 过期日期为必填项", true);
    return;
  }
  const today = new Date().toISOString().slice(0, 10);
  if (exTime < today) {
    setMsg("⛔ 过期日期不能早于今天", true);
    return;
  }
  if (!armed) {
    armed = true;
    confirmBtn.textContent = "再次确认新建？";
    confirmBtn.classList.add("confirming");
    setMsg(`请确认：在 ${groupEl.value} 下新建 VPN 用户 ${name}（过期日期 ${exTime}）`, false);
    return;
  }
  disarm();
  confirmBtn.disabled = true;
  cancelBtn.disabled = true;
  setMsg(`正在新建 VPN 用户 ${name}…`, false);
  try {
    await vpnAddUser(vpnBase, vpnSkey, {
      name,
      parent_group: groupEl.value,
      passwd: passwdEl.value,
      phone: phoneEl.value.trim(),
      note: noteEl.value.trim(),
      ex_time: exTimeEl.value
    });
    setMsg(`✔ VPN 用户 ${name} 新建成功，过期日期：${exTimeEl.value}。`, false);
    confirmBtn.style.display = "none";
    cancelBtn.style.display = "none";
    closeBtn.style.display = "block";
  } catch (err) {
    setMsg("✖ 新建失败：" + err.message, true);
    confirmBtn.disabled = false;
    cancelBtn.disabled = false;
  }
});

init();
