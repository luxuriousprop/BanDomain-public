// vpn-api.js — 深信服 SSLVPN OPENAPI 共享层
// 被 popup.html 与 vpnban.html 共同加载；仅做定义不做动作，可被多页面复用。
// 鉴权（文档第 4 章）：sinfor_apitoken = sha256(Sparams + timestamp + Skey)，
//   Sparams = 请求 URL 参数 + 请求体参数（不含 sinfor_apitoken）按 key 排序后
//   key=value 用 & 拼接；timestamp 为秒级时间戳，与 VPN 时差须在 5 分钟内。

const VPN_DEFAULT_BASE = "https://vpn.example.com:4430";
const VPN_DEFAULT_GROUPS = ["/默认用户组"];
const VPN_TIMEOUT_MS = 10000;

// code -> 中文说明：各接口失败错误列表不同，公共部分放这里，
// 接口特有的（如 -13）在各调用处通过 extraMessages 传入
const VPN_COMMON_CODE_MESSAGES = {
  1: "action 或 controler 不存在",
  4: "API 密钥错误或时间差超过 5 分钟，请检查 Skey 与本机时间",
  404: "请求地址错误"
};

async function sha256Hex(str) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(str));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function vpnApiUrl(base, controler, action) {
  return `${base.replace(/\/+$/, "")}/cgi-bin/php-cgi/html/delegatemodule/WebApi.php?controler=${controler}&action=${action}`;
}

// 构造 Sparams：URL 参数 + 请求体参数按 key 排序后 key=value 用 & 拼接（纯函数，可测试）
// urlParams：拼在 URL query 上的额外参数（如 ExtSetUserEnable 的 type），同样参与签名
function buildSparams(controler, action, bodyParams, timestamp, urlParams = {}) {
  const all = { controler, action, ...urlParams, ...bodyParams, timestamp };
  return Object.keys(all).sort().map((k) => `${k}=${all[k]}`).join("&");
}

// 计算 sinfor_apitoken（纯函数，可单元测试）
async function vpnSign(controler, action, bodyParams, timestamp, skey, urlParams = {}) {
  return sha256Hex(buildSparams(controler, action, bodyParams, timestamp, urlParams) + String(timestamp) + skey);
}

function vpnFetch(url, options, timeoutMs = VPN_TIMEOUT_MS) {
  const controller = new AbortController();
  const tid = setTimeout(() => controller.abort(), timeoutMs);
  return fetch(url, { ...options, signal: controller.signal }).finally(() => clearTimeout(tid));
}

// 通用调用：自动加 timestamp、算签名、POST 表单、解析 JSON 并校验 code
// extraMessages：接口特有的 code 说明（如各接口 -13 含义不同）
// urlParams：拼在 URL query 上的额外参数（参与签名），如 ExtSetUserEnable 的 type
async function vpnApiPost(base, skey, controler, action, bodyParams, extraMessages = {}, urlParams = {}) {
  const timestamp = Math.floor(Date.now() / 1000);
  const body = { ...bodyParams, timestamp };
  const apitoken = await vpnSign(controler, action, bodyParams, timestamp, skey, urlParams);
  let url = vpnApiUrl(base, controler, action);
  if (Object.keys(urlParams).length) url += "&" + new URLSearchParams(urlParams).toString();
  let resp;
  try {
    resp = await vpnFetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ ...body, sinfor_apitoken: apitoken }).toString()
    });
  } catch (err) {
    if (err.name === "AbortError") throw new Error("连接超时：10 秒内未收到 VPN 响应");
    // 走本地中转代理时，给出代理未运行的明确提示
    if (/127\.0\.0\.1|localhost/.test(base)) {
      throw new Error("连接本地代理失败：请确认 vpn-tls-proxy.ps1 正在运行（监听 http://127.0.0.1:8443）");
    }
    // https 自签名/过期证书被浏览器拦截时 fetch 直接失败，给出明确指引
    throw new Error("连接 VPN 失败：请确认地址端口正确，且该地址不经过代理；若 VPN 证书过期或自签名，需先解决证书问题（或改用本地中转代理）");
  }
  let data;
  try {
    data = await resp.json();
  } catch (e) {
    throw new Error(`VPN 返回了非 JSON 响应（HTTP ${resp.status}）`);
  }
  if (data.code !== 0 || data.success !== true) {
    const hint = extraMessages[String(data.code)] || VPN_COMMON_CODE_MESSAGES[String(data.code)];
    throw new Error(`VPN 接口拒绝(code=${data.code}): ${hint || data.message || "无详细信息"}`);
  }
  return data;
}

// 读取 VPN 配置；缺失时抛错（调用方据此提示去设置）
async function getVpnConfig() {
  const cfg = await chrome.storage.local.get(["vpnBase", "vpnSkey", "vpnGroups"]);
  const base = (cfg.vpnBase || "").trim().replace(/\/+$/, "");
  const skey = (cfg.vpnSkey || "").trim();
  const groups = String(cfg.vpnGroups || "").split("\n").map((s) => s.trim()).filter(Boolean);
  if (!base || !skey || !groups.length) {
    throw new Error("请先在设置中配置 VPN 控制器地址、API 密钥与用户组");
  }
  if (!/^https?:\/\/[^/\s]+/i.test(base)) {
    throw new Error("VPN 控制器地址格式不正确，应以 http(s):// 开头");
  }
  return { base, skey, groups };
}

// 用户组路径归一化：去掉末尾斜杠（设备上路径如 /默认用户组，无末尾斜杠）
function normalizeVpnGroup(group) {
  const g = String(group || "");
  if (/^\/+$/.test(g)) return "/"; // 根目录保持 "/"
  return g.replace(/\/+$/, "");
}

// 按 IP 查 VPN 在线用户：逐个用户组拉取后按 nip（接入 IP）或 vip（虚拟 IP）过滤
// 返回 [{ group, user: {name, nip, vip, login_time, ...} }]
// 注意：用户常拿虚拟 IP 来查，必须同时匹配 vip，否则"在线却查不到"
async function vpnQueryOnlineUsersByIp(base, skey, groups, ip) {
  const hits = [];
  const errors = [];
  for (const group of groups) {
    // 注意：parent_group 必须原样发送归一化后的路径，不做其他改动
    const parent_group = normalizeVpnGroup(group);
    try {
      const data = await vpnApiPost(base, skey, "State", "GetOnlineUserCloud", {
        parent_group, start: 0, limit: 100
      }, { "-13": `用户组不存在：${group} 在 VPN 上无匹配，请检查用户组全路径配置` });
      const list = (data.result && data.result.data) || [];
      list.filter((u) => {
        if (!u || ip === "0.0.0.0") return false;
        const nip = String(u.nip || "").trim();
        const vip = String(u.vip || "").trim();
        return nip === ip || vip === ip;
      }).forEach((u) => hits.push({ group, user: u }));
    } catch (err) {
      errors.push({ group, message: err.message });
    }
  }
  return { hits, errors };
}

// 禁用/启用 VPN 用户：enable 0=禁用，1=启用
// 调 5.2.2 用户启用和禁用接口（ExtSetUserEnable）。
// 设备 quirks（诊断插件 5 用例实证）：该 action 的 CheckParams 只从 URL query 取 'type'，
// 写在 POST body 里的 type 会报 "can't find the argument:'type'"；type 缺席时设备默认按
// type=1（用户名模式）处理。这里把 type=1 显式拼在 URL 上（文档：type 为 1 传用户名，
// type 为 0 时传用户组全路径），username/enable 放 body。签名按文档第 4 章把 URL 参数
// 与 body 参数一起排序参与计算。
// （v1.13.9 曾改用 UpdateUserCloud+is_enable 绕行，现已切回本专用接口，不再需要 parent_group。）
async function vpnSetUserEnable(base, skey, username, enable) {
  await vpnApiPost(base, skey, "User", "ExtSetUserEnable",
    { username, enable: String(enable) },
    { "-10": "用户不存在", "-2": "参数类型错误" },
    { type: "1" });
}

// 踢 VPN 在线用户下线；用户不在线(code -13)视为非致命，返回 warning
async function vpnKillUser(base, skey, username) {
  try {
    await vpnApiPost(base, skey, "State", "KillOnlineUserCloud", { users: username },
      { "-13": "users 参数错误（参数格式错误或者用户不在线）" });
    return null;
  } catch (err) {
    if (/code=-13/.test(err.message)) return "用户当前不在线，仅完成禁用";
    throw err;
  }
}

// 拉取全部在线用户（不做 IP 比对）：逐个用户组拉取，返回每组的用户列表与错误
// 返回 [{ group, users: [...], error: null|string }]
async function vpnListAllOnlineUsers(base, skey, groups) {
  const result = [];
  for (const group of groups) {
    try {
      const data = await vpnApiPost(base, skey, "State", "GetOnlineUserCloud", {
        parent_group: normalizeVpnGroup(group), start: 0, limit: 5000
      }, { "-13": `用户组不存在：${group} 在 VPN 上无匹配，请检查用户组全路径配置` });
      const list = (data.result && data.result.data) || [];
      result.push({ group, users: list, error: null });
    } catch (err) {
      result.push({ group, users: [], error: err.message });
    }
  }
  return result;
}

// 查询 VPN 用户详情（文档 5.2.1）：按用户名查，返回完整用户对象
// 注意：接口 result 为 JSON 字符串，需二次解析；-10=用户不存在
async function vpnGetUserInfo(base, skey, username) {
  const data = await vpnApiPost(base, skey, "User", "ExGetUserInfo", { username },
    { "-10": "用户不存在", "-2": "参数错误" });
  let info = data.result;
  if (typeof info === "string") {
    try { info = JSON.parse(info); } catch (e) { throw new Error("查询用户返回解析失败"); }
  }
  return info || {};
}

// 新建 VPN 用户（文档 5.2.4）：name、parent_group 必填；passwd、ex_time 按运维要求视为必填
// b_inherit_auth / b_inherit_grpolicy 显式传 1（继承所属组认证与策略，
// 与控制台默认值一致；文档备注"无值当做 0 处理"，不传可能导致不继承）
// gqsj 反逻辑：1=关闭过期，0=开启过期（此时 ex_time 生效）；新建一律开启过期
async function vpnAddUser(base, skey, { name, parent_group, passwd, phone, note, ex_time }) {
  if (!passwd) throw new Error("密码为必填项");
  if (!ex_time) throw new Error("过期时间为必填项");
  const params = {
    name, parent_group: normalizeVpnGroup(parent_group), passwd,
    b_inherit_auth: "1", b_inherit_grpolicy: "1",
    gqsj: "0", ex_time
  };
  if (phone) params.phone = phone;
  if (note) params.note = note;
  return vpnApiPost(base, skey, "User", "AddUserCloud", params,
    { "-2": "参数错误（用户名已存在/保留/为空）", "-13": "用户组不存在：parent_group 无匹配" });
}

async function vpnBanUser(base, skey, username) {
  await vpnSetUserEnable(base, skey, username, 0);
  const killWarning = await vpnKillUser(base, skey, username);
  return { killWarning };
}

// 续期 VPN 用户（文档 5.2.3 UpdateUserCloud）：只改过期时间，其余字段保持不变
// 注意文档的反逻辑：gqsj=1 表示关闭过期，gqsj=0 表示开启过期（此时 ex_time 生效）
// parent_group 为必填；注意它会把用户挪到该组（不只是定位），续期必须传用户实际所属组
async function vpnRenewUser(base, skey, username, parent_group, ex_time) {
  return vpnApiPost(base, skey, "User", "UpdateUserCloud", {
    old_name: username, new_name: username,
    parent_group: normalizeVpnGroup(parent_group),
    gqsj: "0", ex_time
  }, { "10": "用户不存在（old_name 无匹配）", "-2": "参数错误", "-13": "用户组不存在：parent_group 无匹配" });
}
