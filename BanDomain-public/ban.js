// ban.js — 独立封禁确认窗口的逻辑（与 ban.html 配套，依赖 sam-api.js）
// 待封禁用户经 chrome.storage.session 一次性传递（popup 失焦即关闭，不能放内存）

const userInfoBox = document.getElementById("userInfo");
const dirtyWarnBox = document.getElementById("dirtyWarn");
const daysInput = document.getElementById("daysInput");
const memoInput = document.getElementById("memoInput");
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
  daysInput.value = String(BAN_DEFAULT_DAYS);
  memoInput.value = BAN_DEFAULT_MEMO;

  const key = getPendingKey();
  let pending = null;
  try {
    pending = (await chrome.storage.session.get([key]))[key];
    // 一次性读取后即清理，避免残留
    await chrome.storage.session.remove([key]);
  } catch (err) {
    showMsg("⛔ 读取待封禁信息失败：" + err.message, true);
    confirmBtn.disabled = true;
    return;
  }

  if (!pending || !pending.user || !(pending.user.userId || "").trim()) {
    userInfoBox.textContent = "（无用户信息）";
    showMsg("⛔ 会话已过期或用户信息缺失，请关闭本窗口后重新查询再操作。", true);
    confirmBtn.disabled = true;
    return;
  }

  const { user, ip, samUrl, authHeader } = pending;
  if (!samUrl || !authHeader) {
    userInfoBox.textContent = "（无用户信息）";
    showMsg("⛔ 数据异常，请关闭本窗口后重新查询再操作。", true);
    confirmBtn.disabled = true;
    return;
  }
  // 封禁必须打到查出这条记录的同一台 SAM（内部绑定，不展示给用户）
  const banTarget = { samUrl, authHeader };
  // 选中内容被多选了字符时，提示用户核对提取到的 IP 是否正确
  if (pending.dirtySelection) {
    dirtyWarnBox.textContent =
      `⚠️ 检测到您的选中内容包含多余字符（${pending.dirtySelection}），已自动提取为 ${ip}，请核对无误后再确认封禁。`;
    dirtyWarnBox.style.display = "block";
  }
  // XSS 安全：只用 textContent
  userInfoBox.textContent =
    formatOneUserLines(user, -1).join("\n") + `\n来源 IP：${ip || "—"}`;

  confirmBtn.addEventListener("click", () => doBanConfirm(user, banTarget));
  cancelBtn.addEventListener("click", () => window.close());
  closeBtn.addEventListener("click", () => window.close());
}

async function doBanConfirm(user, banTarget) {
  const days = parseInt(daysInput.value, 10);
  if (!Number.isFinite(days) || days < 1) {
    showMsg("⛔ 封禁天数需为 ≥1 的整数", true);
    return;
  }
  const memo = memoInput.value.trim() || BAN_DEFAULT_MEMO;
  if (memoByteLength(memo) > BAN_MEMO_MAX_BYTES) {
    showMsg(`⛔ 提示信息过长（${memoByteLength(memo)} 字节），SAM 限制 ${BAN_MEMO_MAX_BYTES} 字节`, true);
    return;
  }
  const userId = (user.userId || "").trim();

  confirmBtn.disabled = true;
  cancelBtn.disabled = true;
  showMsg("正在封禁…", false);
  msgBox.style.color = "#0d47a1";

  try {
    const { validTime } = await executeBan(banTarget.samUrl, banTarget.authHeader, userId, days, memo);
    showMsg(
      `✔ 已封禁用户 ${userId}，${days} 天（至 ${validTime.replace("T", " ")}），在线会话已踢下线。\n` +
      `可在主窗口「黑名单管理」中查看或解封。`,
      false
    );
    confirmBtn.style.display = "none";
    cancelBtn.style.display = "none";
    closeBtn.style.display = "block";
  } catch (err) {
    confirmBtn.disabled = false;
    cancelBtn.disabled = false;
    const msg = err.name === "AbortError" ? "连接超时：10 秒内未收到 SAM 响应" : err.message;
    showMsg("✖ 封禁失败：" + msg, true);
  }
}

document.addEventListener("DOMContentLoaded", init);
