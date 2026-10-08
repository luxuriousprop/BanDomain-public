// 默认 API 地址（首次使用时自动填入）
// 注意：Token 出于安全考虑不再内置于代码中，请在"设置"里按实际配置填写
const DEFAULT_API_URL = "http://192.0.2.1:8080/api"; // RFC 5737 文档用地址，请按实际修改

// 静态内置核心白名单（支持自动保护子域名）
const STATIC_WHITE_LIST = Object.freeze([
  "127.0.0.1",
  "localhost",
  "example.com"
]);

// DOM 元素引用
const domainInput = document.getElementById("domainInput");
const blockBtn = document.getElementById("blockBtn");
const unblockBtn = document.getElementById("unblockBtn");
const statusBox = document.getElementById("statusBox");
const toggleSettingsBtn = document.getElementById("toggleSettings");
const settingsPanel = document.getElementById("settingsPanel");
const cfgApiUrl = document.getElementById("cfgApiUrl");
const cfgApiToken = document.getElementById("cfgApiToken");
const saveSettingsBtn = document.getElementById("saveSettingsBtn");
// 在线用户查询相关元素
const ipInput = document.getElementById("ipInput");
const queryUserBtn = document.getElementById("queryUserBtn");
const userResultBox = document.getElementById("userResultBox");
const cfgSamUrl = document.getElementById("cfgSamUrl");
const cfgSamUrl2 = document.getElementById("cfgSamUrl2");
const cfgVpnBase = document.getElementById("cfgVpnBase");
const cfgVpnSkey = document.getElementById("cfgVpnSkey");
const cfgVpnGroups = document.getElementById("cfgVpnGroups");
const cfgSamUser = document.getElementById("cfgSamUser");
const cfgSamPass = document.getElementById("cfgSamPass");
// 诊断信息（记录最近一次查询的请求/响应，供排查）
const diagToggleBtn = document.getElementById("diagToggleBtn");
const diagBox = document.getElementById("diagBox");
let lastDiag = "";
diagToggleBtn.addEventListener("click", () => {
  const show = diagBox.style.display !== "block";
  diagBox.style.display = show ? "block" : "none";
  diagToggleBtn.textContent = show ? "🛠 诊断信息（点击收起）" : "🛠 诊断信息（点开展示请求/响应报文）";
});
function setDiag(text, isError) {
  lastDiag = text;
  diagBox.value = text;
  // 诊断入口仅在出错时展示：成功时隐藏按钮并收起诊断框
  // （处理"上次出错显示过、本次成功要藏回去"的状态翻转）
  diagToggleBtn.style.display = isError ? "inline" : "none";
  if (!isError) {
    diagBox.style.display = "none";
    diagToggleBtn.textContent = "🛠 诊断信息（点开展示请求/响应报文）";
  }
}

// 1. 初始化读取本地安全沙箱存储中的配置
async function loadConfig() {
  const result = await chrome.storage.local.get(["apiUrl", "apiToken", "samUrl", "samUrl2", "samUser", "samPass", "vpnBase", "vpnSkey", "vpnGroups"]);
  cfgApiUrl.value = result.apiUrl || DEFAULT_API_URL;
  // Token 不再提供内置默认值：未配置时保持为空，由请求环节给出明确提示
  cfgApiToken.value = result.apiToken || "";
  cfgSamUrl.value = result.samUrl || "";
  cfgSamUrl2.value = result.samUrl2 || "";
  cfgSamUser.value = result.samUser || "";
  cfgSamPass.value = result.samPass || "";
  // VPN：Skey 永不设默认值，需用户手动填写
  cfgVpnBase.value = result.vpnBase || VPN_DEFAULT_BASE;
  cfgVpnSkey.value = result.vpnSkey || "";
  const savedGroups = String(result.vpnGroups || "").split("\n").map((s) => s.trim()).filter(Boolean);
  cfgVpnGroups.value = (savedGroups.length ? savedGroups : VPN_DEFAULT_GROUPS).join("\n");

  // 首次安装引导：没有任何已存配置时，自动展开设置面板并提示配置
  if (!result.apiUrl && !result.apiToken && !result.samUrl && !result.samUrl2) {
    settingsPanel.style.display = "block";
    renderStatus("👋 首次使用：请先在上方设置面板完成 API 配置（DNS 封禁接口与 SAM 接口至少配置一组），保存后再使用功能。", "loading");
  }
}

// 2. 文本清洗与严格格式验证（防御注入与畸形字符串）
function sanitizeAndExtractDomain(rawText) {
  if (typeof rawText !== "string") return null;

  let text = rawText.trim()
    .replace(/\[\.\]/g, ".")
    .replace(/^hxxps?:\/\//i, "http://");

  let hasWildcard = false;
  if (text.startsWith("*.")) {
    hasWildcard = true;
    text = text.substring(2);
  }

  // 剔除 URL 协议头、路径、端口及请求参数
  text = text.replace(/^https?:\/\//i, "");
  text = text.split(/[:/?#]/)[0].trim().toLowerCase();

  // 严格校验 FQDN 域名格式（仅允许英文字母、数字、短横线与点号）
  const domainPattern = /^(?!-)[a-z0-9-]{1,63}(?<!-)(\.[a-z0-9-]{1,63})+$/;
  if (!domainPattern.test(text)) {
    return null;
  }

  return hasWildcard ? "*." + text : text;
}

// 2b. 批量提取：支持多行 / 逗号 / 分号分隔，自动去重；
//     对告警文本中内嵌的域名做兜底提取
function extractDomains(rawText) {
  const parts = String(rawText || "").split(/[\r\n,;；，、]+/);
  const seen = new Set();
  const valid = [];
  const invalid = [];

  for (const part of parts) {
    const line = part.trim();
    if (!line) continue;

    let domain = sanitizeAndExtractDomain(line);
    if (!domain) {
      // 兜底：从"发现恶意域名 evil[.]com，请处置"这类告警文本里抠出内嵌域名
      const embedded = line.replace(/\[\.\]/g, ".").match(
        /(?:\*\.)?(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}/i
      );
      if (embedded) domain = sanitizeAndExtractDomain(embedded[0]);
    }

    if (!domain) {
      invalid.push(line.length > 40 ? line.slice(0, 40) + "…" : line);
      continue;
    }
    const key = domain.toLowerCase();
    if (!seen.has(key)) {
      seen.add(key);
      valid.push(domain);
    }
  }
  return { valid, invalid };
}

// 3. 白名单匹配校验
function isWhiteListed(domain) {
  const pureDomain = domain.toLowerCase().replace(/^\*\./, "");
  return STATIC_WHITE_LIST.some((allowed) => {
    const pureAllowed = allowed.toLowerCase().replace(/^\*\./, "");
    return pureDomain === pureAllowed || pureDomain.endsWith("." + pureAllowed);
  });
}

// 4. 安全序列化：保留 * 字面量，转义非法参数防注入
function secureSerializeFormData(params) {
  return Object.entries(params)
    .map(([key, val]) => {
      const safeKey = encodeURIComponent(String(key).trim());
      // 允许合法的通配符 * 保持字面量，其余特殊字符一律编码
      const safeVal = encodeURIComponent(String(val).trim()).replace(/%2A/gi, "*");
      return `${safeKey}=${safeVal}`;
    })
    .join("&");
}

// 5. 解析 SOAP/JSON 响应数据
function extractJsonResult(data) {
  if (data && typeof data === "object" && "ret" in data) {
    if (String(data.ret) === "0") {
      return { success: true, message: data.data?.msg || "操作成功" };
    }
    return { success: false, message: `业务拒绝(ret=${data.ret}): ${JSON.stringify(data.data ?? {})}` };
  }
  return null;
}

// 从文本中提取包含 "ret" 的完整 JSON 对象（括号配平，可处理嵌套与 SOAP 包裹）
// 修复了原贪婪正则 /\{[\s\S]*"ret"[\s\S]*\}/ 可能吞掉多余内容导致 JSON.parse 失败的问题
function extractJsonObject(text) {
  const keyIdx = text.indexOf('"ret"');
  if (keyIdx === -1) return null;
  const start = text.lastIndexOf("{", keyIdx);
  if (start === -1) return null;

  let depth = 0, inStr = false, esc = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === "\\") esc = true;
      else if (ch === '"') inStr = false;
    } else if (ch === '"') {
      inStr = true;
    } else if (ch === "{") {
      depth++;
    } else if (ch === "}") {
      depth--;
      if (depth === 0) {
        try {
          return JSON.parse(text.slice(start, i + 1));
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}

function parseSoapResult(xmlText) {
  const text = String(xmlText || "").trim();

  // 优先按纯 JSON 响应解析
  if (text.startsWith("{")) {
    try {
      const direct = extractJsonResult(JSON.parse(text));
      if (direct) return direct;
    } catch {
      // 非纯 JSON，继续走 SOAP 包裹提取
    }
  }

  // 从 SOAP/XML 包裹中提取 JSON
  const embedded = extractJsonObject(text);
  if (embedded) {
    const result = extractJsonResult(embedded);
    if (result) return result;
  }

  const faultMatch = text.match(/<faultstring>([\s\S]*?)<\/faultstring>/i);
  if (faultMatch) {
    return { success: false, message: `SOAP错误: ${faultMatch[1].trim()}` };
  }

  return { success: false, message: "接口未返回合规的 SOAP/JSON 响应体" };
}

// 6. 发起带有超时机制的安全请求
async function executeApiRequest(actionName, domain, extraParams = {}) {
  const config = await chrome.storage.local.get(["apiUrl", "apiToken"]);
  const targetUrl = (config.apiUrl || "").trim() || DEFAULT_API_URL;
  const token = (config.apiToken || "").trim();

  // Token 不再有内置回退值：未配置时给出明确提示，而非静默使用硬编码密钥
  if (!token) {
    throw new Error("请先在设置中配置有效 Token");
  }

  const payload = {
    token: token,
    action: actionName,
    p1: domain,
    ...extraParams
  };

  const bodyData = secureSerializeFormData(payload);

  // 设置 8 秒请求超时控制器
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 8000);

  try {
    const response = await fetch(targetUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded"
      },
      body: bodyData,
      signal: controller.signal
    });

    clearTimeout(timeoutId);

    if (!response.ok) {
      throw new Error(`HTTP 异常状态码: ${response.status}`);
    }

    const xmlResponse = await response.text();
    const result = parseSoapResult(xmlResponse);

    if (!result.success) {
      throw new Error(result.message);
    }

    return result;
  } catch (err) {
    clearTimeout(timeoutId);
    if (err.name === "AbortError") {
      throw new Error("连接超时：8秒内未收到 DNS 服务器响应");
    }
    throw err;
  }
}

// 7. XSS 安全的 UI 状态渲染（杜绝 innerHTML，使用 textContent）
function renderStatus(message, type) {
  statusBox.style.display = "block";

  if (type === "loading") {
    statusBox.style.backgroundColor = "#e3f2fd";
    statusBox.style.color = "#0d47a1";
  } else if (type === "success") {
    statusBox.style.backgroundColor = "#e8f5e9";
    statusBox.style.color = "#1b5e20";
  } else {
    statusBox.style.backgroundColor = "#ffebee";
    statusBox.style.color = "#b71c1c";
  }

  statusBox.textContent = message;
}

function setActionBusy(isBusy) {
  blockBtn.disabled = isBusy;
  unblockBtn.disabled = isBusy;
  domainInput.disabled = isBusy;
}

// 8. 批量业务执行：逐个串行提交，汇总每条结果
async function runBatch(actionName, actionLabel, extraParams = {}) {
  // 未配置 Token 时直接报错并自动打开设置面板，不进入批量流程
  const preCfg = await chrome.storage.local.get(["apiToken"]);
  if (!(preCfg.apiToken || "").trim()) {
    renderStatus("⛔ 尚未配置鉴权 Token，已为你打开设置面板，请填写后保存再操作。", "error");
    settingsPanel.style.display = "block";
    return;
  }

  const { valid, invalid } = extractDomains(domainInput.value);

  if (valid.length === 0 && invalid.length === 0) {
    renderStatus("请输入至少一个域名", "error");
    return;
  }

  setActionBusy(true);
  const lines = [];
  let ok = 0, fail = 0, skip = 0;

  for (let i = 0; i < valid.length; i++) {
    const domain = valid[i];

    // 封禁时命中核心白名单则跳过保护（解封操作不受此限制）
    if (actionName === "AddDnsRpz" && isWhiteListed(domain)) {
      skip++;
      lines.push(`⚠ 跳过白名单保护：${domain}`);
      continue;
    }

    renderStatus(`正在${actionLabel} (${i + 1}/${valid.length})：${domain}...`, "loading");

    try {
      await executeApiRequest(actionName, domain, extraParams);
      ok++;
      lines.push(`✔ ${domain}`);
    } catch (err) {
      fail++;
      lines.push(`✖ ${domain}：${err.message}`);
    }
  }
  setActionBusy(false);

  const summary = `${actionLabel}完成：成功 ${ok} 个` +
    (fail ? `，失败 ${fail} 个` : "") +
    (skip ? `，跳过白名单 ${skip} 个` : "") +
    (invalid.length ? `，非法输入 ${invalid.length} 行` : "");
  if (invalid.length) {
    lines.push(`⛔ 非法输入：${invalid.slice(0, 5).join("、")}${invalid.length > 5 ? "…" : ""}`);
  }
  renderStatus([summary, ...lines].join("\n"), (fail > 0 || invalid.length > 0) ? "error" : "success");
}

// 9. 业务交互绑定
blockBtn.addEventListener("click", () => {
  runBatch("AddDnsRpz", "封禁", { p2: "300", p3: "127.0.0.1" });
});

unblockBtn.addEventListener("click", () => {
  runBatch("DelDnsRpz", "解封");
});

// 设置抽屉折叠交互与保存（含格式校验）
toggleSettingsBtn.addEventListener("click", () => {
  settingsPanel.style.display = settingsPanel.style.display === "block" ? "none" : "block";
});

saveSettingsBtn.addEventListener("click", async () => {
  const newUrl = cfgApiUrl.value.trim().replace(/\/+$/, "");
  const newToken = cfgApiToken.value.trim();

  if (!/^https?:\/\/[^/\s]+/i.test(newUrl)) {
    renderStatus("⛔ API 地址格式不正确，应以 http:// 或 https:// 开头", "error");
    return;
  }
  if (!newToken) {
    renderStatus("⛔ Token 不能为空，请填写访问密钥", "error");
    return;
  }

  const newSamUrl = cfgSamUrl.value.trim().replace(/\/+$/, "");
  const newSamUrl2 = cfgSamUrl2.value.trim().replace(/\/+$/, "");
  const newSamUser = cfgSamUser.value.trim();
  const newSamPass = cfgSamPass.value; // 密码不做 trim，避免误伤含空格的口令
  if (newSamUrl && !/^https?:\/\/[^/\s]+/i.test(newSamUrl)) {
    renderStatus("⛔ SAM 接口地址格式不正确，应以 http(s):// 开头，例如 http://SAM服务器IP:8080/sam/services/samapi", "error");
    return;
  }
  if (newSamUrl2 && !/^https?:\/\/[^/\s]+/i.test(newSamUrl2)) {
    renderStatus("⛔ SAM2 接口地址格式不正确，应以 http(s):// 开头", "error");
    return;
  }
  if ((newSamUrl || newSamUrl2 || newSamUser || newSamPass) && !((newSamUrl || newSamUrl2) && newSamUser && newSamPass)) {
    renderStatus("⛔ SAM 配置需齐全（至少一个接口地址 + 用户名 + 密码），否则在线用户查询不可用", "error");
    return;
  }

  const newVpnBase = cfgVpnBase.value.trim().replace(/\/+$/, "");
  const newVpnSkey = cfgVpnSkey.value.trim();
  const newVpnGroups = cfgVpnGroups.value.split("\n").map((s) => s.trim()).filter(Boolean);
  if ((newVpnBase || newVpnSkey || newVpnGroups.length) && !(newVpnBase && newVpnSkey && newVpnGroups.length)) {
    renderStatus("⛔ VPN 配置需齐全（控制器地址、API 密钥、至少一个用户组），否则 VPN 查询不可用", "error");
    return;
  }
  if (newVpnBase && !/^https?:\/\/[^/\s]+/i.test(newVpnBase)) {
    renderStatus("⛔ VPN 控制器地址格式不正确，应以 http(s):// 开头", "error");
    return;
  }

  await chrome.storage.local.set({
    apiUrl: newUrl,
    apiToken: newToken,
    samUrl: newSamUrl,
    samUrl2: newSamUrl2,
    samUser: newSamUser,
    samPass: newSamPass,
    vpnBase: newVpnBase,
    vpnSkey: newVpnSkey,
    vpnGroups: newVpnGroups.join("\n")
  });

  settingsPanel.style.display = "none";
  renderStatus("✔ 配置参数已安全更新到本地沙箱", "success");
});

// 脚本载入时读取本地配置，并恢复上次 VPN 查询回显
document.addEventListener("DOMContentLoaded", () => {
  loadConfig();
  restoreVpnResult();
});

// ============================================================
// 10. 在线用户查询：调用 SAM 第三方接口 queryOnlineUser，
//     按 IP 查在线用户并回显用户名（userId / userName）
//     接口文档：SAM API V2，方法 queryOnlineUser(QueryOnlineUserParam)
//     服务地址形如 http://SAM_IP:8080/sam/services/samapi（https 为 :8443）
// ============================================================

// WSDL targetNamespace 缺省值（SAM API 文档 / demo 一致）；优先从 ?wsdl 实时发现


// 各方法经真实 WSDL 确认的缺省参数结构；?wsdl 成功会覆盖

// 黑名单功能常量




// 缓存 WSDL 发现结果：key 为 endpoint::method



// 回显字段：SAM OnlineUserInfo 属性 -> 中文标签


// accessType 代码含义（SAM API V2 文档）


// 宽松校验 IPv4 / IPv6（服务端为最终权威校验）




// XML 文本转义（防注入破坏 SOAP 信封）


// HTTP Basic 认证头（兼容非 ASCII 用户名/密码）


// 从 SAM 的 ?wsdl 实时发现指定方法的参数结构（targetNamespace + 包裹层名 + 是否 qualified）。
// 不同 SAM 版本/方法的 WSDL 差异很大，缺省值取 SAM_METHOD_DEFAULTS（经真实 WSDL 确认）。
// 成功的发现结果按 endpoint::method 缓存到内存与 chrome.storage.local。


// 兼容旧调用：查询在线用户的方法发现


// 通用 SOAP 1.1 信封构造：method 为方法名，op 为 discoverSamMethod 结果，
// fieldsXml 为已转义好的字段 XML（调用方负责 xmlEscape）


// 构造 queryOnlineUser 的 SOAP 1.1 请求信封（结构随 WSDL 发现结果自适应）


// ---- 黑名单相关 ----

// 本地时间格式化为 SAM dateTime：YYYY-MM-DDTHH:mm:ss

// 按天数计算封禁失效时间

// memo 字节长度校验（SAM 限制 250 字节）

// 通用 SAM SOAP POST（超时、认证错误统一处理），返回响应文本

// 读取 SAM 配置（地址/用户名/密码），缺失时抛错

// 解析 SOAP 响应 return 节点：校验 errorCode，返回 return 作用域元素

// 解析 queryInhibit 响应，返回黑名单规则数组

// 规则是否处于生效中（启用 且 有效期晚于当前）

// validTime 展示格式：2026-10-03T10:35:16.107+08:00 -> 2026-10-03 10:35


// 按本地名取第一个子孙元素（忽略命名空间前缀差异）



// 解析 queryOnlineUser 响应，返回在线用户信息数组


// XSS 安全的结果渲染（只用 textContent）
function renderUserResult(message, isError) {
  userResultBox.style.display = "block";
  userResultBox.classList.toggle("error", !!isError);
  userResultBox.textContent = message;
}



queryUserBtn.addEventListener("click", async () => {
  const ip = ipInput.value.trim();

  if (!isValidIp(ip)) {
    renderUserResult("⛔ IP 地址格式不正确，请输入合法的 IPv4/IPv6 地址", true);
    return;
  }

  let samList;
  try {
    samList = await getSamConfigs();
  } catch (err) {
    renderUserResult("⛔ " + err.message + "（已为你打开设置面板）", true);
    settingsPanel.style.display = "block";
    return;
  }

  queryUserBtn.disabled = true;
  renderUserResult(`正在查询 ${ip} 的在线用户…`, false);
  const diag = [`[SAM 查询诊断] ${new Date().toLocaleString()}`, `并行查询: ${samList.map((s) => `${s.name}=${s.url}`).join("；")}`];

  try {
    const { results, errors } = await queryOnlineUsersMulti(samList, ip);
    const total = results.reduce((n, r) => n + r.users.length, 0);
    diag.push(`各 SAM 结果: ${results.map((r) => `${r.sam.name}:${r.users.length}条`).join("，") || "无"}`);
    if (errors.length) {
      diag.push(`失败: ${errors.map((e) => `${e.sam.name}(${e.message})`).join("；")}`);
    }
    if (total === 0) {
      let msg = `IP ${ip} 当前无在线用户记录（可能已下线）`;
      if (errors.length) {
        msg += `\n⚠️ 部分查询失败：${errors[0].message}（结果可能不完整）`;
      }
      diag.push("结果: 无记录");
      setDiag(diag.join("\n"), errors.length > 0); // 有失败才展示诊断入口
      renderUserResult(msg, true);
    } else {
      setDiag(diag.join("\n"), false);
      renderUserRecordsMulti(ip, results, errors);
    }
  } catch (err) {
    const msg = err.name === "AbortError" ? "连接超时：10 秒内未收到 SAM 响应" : err.message;
    diag.push(`错误: ${msg}`);
    setDiag(diag.join("\n"), true);
    diagBox.style.display = "block";
    diagToggleBtn.textContent = "🛠 诊断信息（点击收起）";
    renderUserResult("✖ 查询失败：" + msg, true);
  } finally {
    queryUserBtn.disabled = false;
  }
});

// ============================================================
// 11. 黑名单封禁：IP 查到用户名后，按用户名 addInhibit 拉黑
//     （启用+有效期在未来 → 满足规则的在线用户会被立即踢下线）
// ============================================================

const samMoreBtn = document.getElementById("samMoreBtn");
const samMoreMenu = document.getElementById("samMoreMenu");
const samMenuBanList = document.getElementById("samMenuBanList");
const banListBox = document.getElementById("banListBox");
let banListVisible = false;

// 单条在线记录的文本行（XSS 安全：调用方用 textContent 渲染）


// 渲染在线用户记录：每条记录带一个闪动的封禁按钮（DOM 方式，XSS 安全）
// 多 SAM 查询结果渲染：用户视角只有"一台 SAM"，不标注来源；
// 封禁按钮内部仍绑定记录来源的 SAM 身份，保证打到正确的那台。
function renderUserRecordsMulti(ip, results, errors) {
  userResultBox.style.display = "block";
  userResultBox.classList.remove("error");
  userResultBox.textContent = "";

  const total = results.reduce((n, r) => n + r.users.length, 0);
  const head = document.createElement("div");
  head.style.fontWeight = "700";
  head.textContent = `IP ${ip} 共找到 ${total} 条在线记录`;
  userResultBox.appendChild(head);

  if (errors.length) {
    const ew = document.createElement("div");
    ew.style.color = "#b71c1c";
    ew.textContent = `⚠️ 部分查询失败：${errors[0].message}（结果可能不完整）`;
    userResultBox.appendChild(ew);
  }

  results.forEach(({ sam, users }) => {
    users.forEach((u, idx) => {
      const rec = document.createElement("div");
      rec.className = "user-record";

      const info = document.createElement("div");
      info.className = "user-info";
      info.textContent = formatOneUserLines(u, users.length > 1 ? idx : -1).join("\n");
      rec.appendChild(info);

      const banBtn = document.createElement("button");
      banBtn.className = "ban-btn";
      banBtn.textContent = "🚫 封禁此用户";
      banBtn.addEventListener("click", (e) => openBanWindow(u, ip, banBtn, e, sam));
      rec.appendChild(banBtn);

      userResultBox.appendChild(rec);
    });
  });
}

// 展开/收起某条记录的封禁确认行


// 执行封禁：先查是否已有生效规则（防重复），再 addInhibit


// 点击封禁按钮：把待封禁用户写入一次性会话存储，弹出独立确认窗口。
// popup 失去焦点会自动关闭，因此上下文必须走 storage.session 传递，不能放内存变量。
// sam 为记录来源的 SAM 身份 {name, url, authHeader}：封禁必须打到同一台 SAM。
// 新窗口以点击点为中心弹出（视觉焦点不跳跃），并钳制在可用屏幕范围内。
async function openBanWindow(user, ip, banBtn, clickEvent, sam) {
  const key = "banPending_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  try {
    await chrome.storage.session.set({
      [key]: { user, ip, samUrl: sam.url, authHeader: sam.authHeader, samName: sam.name }
    });
  } catch (err) {
    renderUserResult("⛔ 无法打开封禁窗口：" + err.message, true);
    return;
  }
  banBtn.disabled = true;
  try {
    await chrome.windows.create({
      url: chrome.runtime.getURL("ban.html") + "?key=" + encodeURIComponent(key),
      type: "popup",
      width: BAN_WIN_W,
      height: BAN_WIN_H,
      ...banWindowPosition(clickEvent)
    });
  } finally {
    banBtn.disabled = false;
  }
}

// 点击"封禁VPN"：待封禁用户写入一次性会话存储，弹出独立确认窗口
async function openVpnBanWindow(user, ip, group, banBtn, clickEvent, vpnCfg) {
  const key = "vpnBanPending_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  try {
    await chrome.storage.session.set({
      [key]: {
        user: { name: user.name, nip: user.nip, vip: user.vip, login_time: user.login_time, grp: user.grp },
        ip, group, vpnBase: vpnCfg.base, vpnSkey: vpnCfg.skey
      }
    });
  } catch (err) {
    renderVpnResult("⛔ 无法打开封禁窗口：" + err.message, true);
    return;
  }
  banBtn.disabled = true;
  try {
    await chrome.windows.create({
      url: chrome.runtime.getURL("vpnban.html") + "?key=" + encodeURIComponent(key),
      type: "popup",
      width: BAN_WIN_W,
      height: BAN_WIN_H,
      ...banWindowPosition(clickEvent)
    });
  } finally {
    banBtn.disabled = false;
  }
}

const BAN_WIN_W = 400;
const BAN_WIN_H = 540;

// 计算封禁窗口的屏幕坐标：以点击点为中心；clickEvent 缺失时退化为当前 popup 中心；
// 结果钳制在当前屏幕可用区域内，避免窗口越界。
function banWindowPosition(clickEvent) {
  let cx, cy;
  if (clickEvent && Number.isFinite(clickEvent.clientX) && Number.isFinite(clickEvent.clientY)) {
    // clientX/Y 是相对 popup 视口的，加上 popup 自身的屏幕坐标即为屏幕绝对坐标
    cx = window.screenX + clickEvent.clientX;
    cy = window.screenY + clickEvent.clientY;
  } else {
    cx = window.screenX + window.outerWidth / 2;
    cy = window.screenY + window.outerHeight / 2;
  }
  const availLeft = window.screen.availLeft || 0;
  const availTop = window.screen.availTop || 0;
  const availWidth = window.screen.availWidth || window.screen.width;
  const availHeight = window.screen.availHeight || window.screen.height;
  const left = Math.min(
    Math.max(Math.round(cx - BAN_WIN_W / 2), availLeft),
    Math.max(availLeft, availLeft + availWidth - BAN_WIN_W)
  );
  const top = Math.min(
    Math.max(Math.round(cy - BAN_WIN_H / 2), availTop),
    Math.max(availTop, availTop + availHeight - BAN_WIN_H)
  );
  return { left, top };
}

// ============================================================
// 12. 黑名单名单：查看已封禁规则，逐条解封
// ============================================================

// "更多"下拉菜单（SAM，参考 VPN 做法）
samMoreBtn.addEventListener("click", (e) => {
  e.stopPropagation();
  samMoreMenu.style.display = samMoreMenu.style.display === "none" ? "block" : "none";
});
document.addEventListener("click", () => { samMoreMenu.style.display = "none"; });
samMenuBanList.addEventListener("click", () => {
  samMoreMenu.style.display = "none";
  toggleBanList();
});

let banListLoading = false;
async function toggleBanList() {
  if (banListLoading) return;
  if (banListVisible) {
    banListVisible = false;
    banListBox.style.display = "none";
    samMenuBanList.textContent = "已封禁名单";
    return;
  }
  banListLoading = true;
  try {
    await refreshBanList();
    banListVisible = true;
    banListBox.style.display = "block";
    samMenuBanList.textContent = "收起已封禁名单";
  } finally {
    banListLoading = false;
  }
}

async function refreshBanList() {
  banListBox.textContent = "";
  const loading = document.createElement("div");
  loading.style.padding = "6px";
  loading.textContent = "正在加载黑名单…";
  banListBox.appendChild(loading);

  let samList;
  try {
    samList = await getSamConfigs();
  } catch (err) {
    banListBox.textContent = "";
    const errDiv = document.createElement("div");
    errDiv.style.cssText = "padding:6px;color:#b71c1c;";
    errDiv.textContent = "✖ 加载失败：" + err.message + "（已为你打开设置面板）";
    banListBox.appendChild(errDiv);
    settingsPanel.style.display = "block";
    return;
  }

  try {
    const { results, errors } = await queryInhibitMulti(samList, BAN_LIST_LIMIT);
    const rules = [];
    results.forEach(({ rules: rs }) => rs.forEach((r) => rules.push(r)));
    banListBox.textContent = "";

    if (errors.length) {
      const ew = document.createElement("div");
      ew.style.cssText = "padding:6px;color:#b71c1c;";
      ew.textContent = `⚠️ 部分加载失败：${errors[0].message}（名单可能不完整）`;
      banListBox.appendChild(ew);
    }

    if (rules.length === 0) {
      const empty = document.createElement("div");
      empty.style.padding = "6px";
      empty.style.color = "#666";
      empty.textContent = "当前无黑名单规则";
      banListBox.appendChild(empty);
      return;
    }

    // 生效中的排前面
    rules.sort((a, b) => (isRuleActive(b) ? 1 : 0) - (isRuleActive(a) ? 1 : 0));
    for (const rule of rules) {
      const row = document.createElement("div");
      row.className = "ban-row";
      const active = isRuleActive(rule);

      const line1 = document.createElement("div");
      line1.textContent = `${rule.userId || "(未知用户)"}　${active ? "●生效中" : "○已过期/停用"}`;
      line1.style.fontWeight = "700";
      if (!active) line1.classList.add("expired");
      row.appendChild(line1);

      const line2 = document.createElement("div");
      line2.textContent = `有效期至 ${formatValidTime(rule.validTime)}${rule.memo ? `｜${rule.memo.slice(0, 24)}${rule.memo.length > 24 ? "…" : ""}` : ""}`;
      line2.style.color = "#666";
      row.appendChild(line2);

      if (rule.inhibitUuid) {
        const unbanBtn = document.createElement("button");
        unbanBtn.className = "unban-btn";
        unbanBtn.textContent = "解封";
        unbanBtn.addEventListener("click", () => {
          if (!unbanBtn.classList.contains("confirming")) {
            unbanBtn.classList.add("confirming");
            unbanBtn.textContent = "确认解封？";
            return;
          }
          doUnban(rule, unbanBtn, row);
        });
        line1.appendChild(unbanBtn);
      }
      banListBox.appendChild(row);
    }
  } catch (err) {
    banListBox.textContent = "";
    const errDiv = document.createElement("div");
    errDiv.style.padding = "6px";
    errDiv.style.color = "#b71c1c";
    errDiv.textContent = "✖ 加载失败：" + (err.name === "AbortError" ? "连接超时" : err.message);
    if (err.message && err.message.includes("请先在设置中配置")) {
      errDiv.textContent += "（已为你打开设置面板）";
      settingsPanel.style.display = "block";
    }
    banListBox.appendChild(errDiv);
    throw err;
  }
}

async function doUnban(rule, btn, row) {
  btn.disabled = true;
  btn.textContent = "解封中…";
  try {
    const sam = rule._sam;
    if (!sam || !sam.url || !sam.authHeader) {
      throw new Error("数据异常，请收起后重新加载列表再试");
    }
    const op = await discoverSamMethod(sam.url, sam.authHeader, "deleteInhibit");
    const xml = await samSoapPost(
      sam.url, sam.authHeader,
      buildSoapEnvelope("deleteInhibit", op, `<uuid>${xmlEscape(rule.inhibitUuid)}</uuid>`)
    );
    parseSoapReturn(xml, "deleteInhibitResponse"); // 仅校验 errorCode
    await refreshBanList();
  } catch (err) {
    btn.disabled = false;
    btn.classList.remove("confirming");
    btn.textContent = "解封";
    const errDiv = document.createElement("div");
    errDiv.style.color = "#b71c1c";
    errDiv.textContent = "✖ 解封失败：" + (err.name === "AbortError" ? "连接超时" : err.message);
    row.appendChild(errDiv);
  }
}

// ============================================================
// 13. VPN 在线用户查询与封禁（深信服 SSLVPN OPENAPI）
// ============================================================
const vpnIpInput = document.getElementById("vpnIpInput");
const queryVpnUserBtn = document.getElementById("queryVpnUserBtn");
const vpnMoreBtn = document.getElementById("vpnMoreBtn");
const vpnMoreMenu = document.getElementById("vpnMoreMenu");
const vpnMenuListAll = document.getElementById("vpnMenuListAll");
const vpnMenuAddUser = document.getElementById("vpnMenuAddUser");
const vpnMenuRenew = document.getElementById("vpnMenuRenew");
const vpnUserResultBox = document.getElementById("vpnUserResultBox");

function renderVpnResult(message, isError) {
  vpnUserResultBox.style.display = "block";
  vpnUserResultBox.classList.toggle("error", !!isError);
  vpnUserResultBox.textContent = message;
}

// VPN 查询回显持久化：popup 失焦关闭后重开，能恢复上次的回显（不用重新查询）
// 快照存 chrome.storage.session（仅内存，浏览器重启自动清除，不含密码等秘密）
const VPN_RESULT_KEY = "vpnLastResult";
function saveVpnResult(snapshot) {
  try {
    chrome.storage.session.set({ [VPN_RESULT_KEY]: snapshot }).catch(() => {});
  } catch (e) { /* 忽略 */ }
}

// popup 重开时恢复上次 VPN 查询回显
async function restoreVpnResult() {
  let snap;
  try {
    snap = (await chrome.storage.session.get(VPN_RESULT_KEY))[VPN_RESULT_KEY];
  } catch (e) { return; }
  if (!snap || !snap.kind) return;
  let vpnCfg;
  try {
    vpnCfg = await getVpnConfig();
  } catch (e) { return; }
  try {
    if (snap.kind === "query") {
      vpnIpInput.value = snap.ip || "";
      renderVpnUserRecords(snap.ip, snap.hits || [], snap.errors || [], vpnCfg);
    } else if (snap.kind === "listAll") {
      renderVpnAllUsers(snap.groups || [], vpnCfg);
    } else if (snap.kind === "msg") {
      renderVpnResult(snap.text || "", !!snap.isError);
    }
  } catch (e) { /* 快照损坏则忽略 */ }
}

function formatVpnUserLines(u) {
  const lines = [];
  if (u.name) lines.push(`用户名：${u.name}`);
  if (u.nip) lines.push(`来访 IP：${u.nip}`);
  if (u.vip && u.vip !== "0.0.0.0") lines.push(`虚拟 IP：${u.vip}`);
  if (u.login_time) lines.push(`登录时间：${u.login_time}`);
  if (u.login_duration) lines.push(`在线时长：${u.login_duration}`);
  if (u.grp) lines.push(`用户组：${u.grp}`);
  return lines;
}

queryVpnUserBtn.addEventListener("click", async () => {
  const ip = vpnIpInput.value.trim();

  if (!isValidIp(ip)) {
    renderVpnResult("⛔ IP 地址格式不正确，请输入合法的 IPv4/IPv6 地址", true);
    return;
  }

  let vpnCfg;
  try {
    vpnCfg = await getVpnConfig();
  } catch (err) {
    renderVpnResult("⛔ " + err.message + "（已为你打开设置面板）", true);
    settingsPanel.style.display = "block";
    return;
  }

  queryVpnUserBtn.disabled = true;
  renderVpnResult(`正在查询 ${ip} 的 VPN 在线用户（${vpnCfg.groups.length} 个用户组）…`, false);

  try {
    const { hits, errors } = await vpnQueryOnlineUsersByIp(vpnCfg.base, vpnCfg.skey, vpnCfg.groups, ip);
    if (!hits.length) {
      let msg = `IP ${ip} 在 VPN 在线用户中未找到（可能已下线或不在所配用户组内）`;
      if (errors.length) {
        msg += `\n⚠️ 部分用户组查询失败：${errors[0].message}（结果可能不完整）`;
      }
      renderVpnResult(msg, true);
      saveVpnResult({ kind: "msg", text: msg, isError: true });
    } else {
      renderVpnUserRecords(ip, hits, errors, vpnCfg);
      saveVpnResult({ kind: "query", ip, hits, errors });
    }
  } catch (err) {
    const msg = "✖ 查询失败：" + err.message;
    renderVpnResult(msg, true);
    saveVpnResult({ kind: "msg", text: msg, isError: true });
  } finally {
    queryVpnUserBtn.disabled = false;
  }
});

// "更多"下拉菜单
vpnMoreBtn.addEventListener("click", (e) => {
  e.stopPropagation();
  vpnMoreMenu.style.display = vpnMoreMenu.style.display === "none" ? "block" : "none";
});
document.addEventListener("click", () => { vpnMoreMenu.style.display = "none"; });
vpnMenuListAll.addEventListener("click", () => {
  vpnMoreMenu.style.display = "none";
  doVpnListAll();
});
vpnMenuAddUser.addEventListener("click", () => {
  vpnMoreMenu.style.display = "none";
  openVpnAddUserWindow();
});
vpnMenuRenew.addEventListener("click", () => {
  vpnMoreMenu.style.display = "none";
  openVpnRenewWindow();
});

// 打开新建用户独立窗口
async function openVpnAddUserWindow() {
  let vpnCfg;
  try {
    vpnCfg = await getVpnConfig();
  } catch (err) {
    renderVpnResult("⛔ " + err.message + "（已为你打开设置面板）", true);
    settingsPanel.style.display = "block";
    return;
  }
  const key = "vpnAddUserCfg_" + Date.now().toString(36);
  try {
    await chrome.storage.session.set({
      [key]: { vpnBase: vpnCfg.base, vpnSkey: vpnCfg.skey, vpnGroups: vpnCfg.groups }
    });
  } catch (err) {
    renderVpnResult("⛔ 无法打开新建用户窗口：" + err.message, true);
    return;
  }
  await chrome.windows.create({
    url: chrome.runtime.getURL("vpnadduser.html") + "?key=" + encodeURIComponent(key),
    type: "popup",
    ...await vpnCenteredPosition(380, 500)
  });
}

// 新建/续期窗口居中：在当前 popup 所在屏幕的工作区居中，宽高不超过屏幕（自适应）
async function vpnCenteredPosition(w, h) {
  let ax = window.screen.availLeft || 0, ay = window.screen.availTop || 0;
  let aw = window.screen.availWidth, ah = window.screen.availHeight;
  try {
    const displays = await chrome.system.display.getInfo();
    if (displays && displays.length) {
      const sx = window.screenX, sy = window.screenY;
      const d = displays.find(d => sx >= d.bounds.left && sx < d.bounds.left + d.bounds.width &&
                                   sy >= d.bounds.top && sy < d.bounds.top + d.bounds.height)
                || displays.find(d => d.isPrimary) || displays[0];
      if (d && d.workArea) {
        ax = d.workArea.left; ay = d.workArea.top;
        aw = d.workArea.width; ah = d.workArea.height;
      }
    }
  } catch (e) { /* 取不到则回退到 screen.avail* */ }
  const W = Math.min(w, Math.max(200, aw - 20));
  const H = Math.min(h, Math.max(200, ah - 20));
  return {
    width: W, height: H,
    left: Math.round(ax + (aw - W) / 2),
    top: Math.round(ay + (ah - H) / 2)
  };
}

// 打开用户续期独立窗口
async function openVpnRenewWindow() {
  let vpnCfg;
  try {
    vpnCfg = await getVpnConfig();
  } catch (err) {
    renderVpnResult("⛔ " + err.message + "（已为你打开设置面板）", true);
    settingsPanel.style.display = "block";
    return;
  }
  const key = "vpnRenewCfg_" + Date.now().toString(36);
  try {
    await chrome.storage.session.set({
      [key]: { vpnBase: vpnCfg.base, vpnSkey: vpnCfg.skey, vpnGroups: vpnCfg.groups }
    });
  } catch (err) {
    renderVpnResult("⛔ 无法打开续期窗口：" + err.message, true);
    return;
  }
  await chrome.windows.create({
    url: chrome.runtime.getURL("vpnrenew.html") + "?key=" + encodeURIComponent(key),
    type: "popup",
    ...await vpnCenteredPosition(380, 430)
  });
}

// 在线用户查询：不按 IP 比对，直接列出各组返回的用户（排查"在线却查不到"用）
async function doVpnListAll() {
  let vpnCfg;
  try {
    vpnCfg = await getVpnConfig();
  } catch (err) {
    renderVpnResult("⛔ " + err.message + "（已为你打开设置面板）", true);
    settingsPanel.style.display = "block";
    return;
  }
  renderVpnResult(`正在查询 ${vpnCfg.groups.length} 个用户组的在线用户…`, false);
  try {
    const groups = await vpnListAllOnlineUsers(vpnCfg.base, vpnCfg.skey, vpnCfg.groups);
    renderVpnAllUsers(groups, vpnCfg);
    saveVpnResult({ kind: "listAll", groups });
  } catch (err) {
    const msg = "✖ 拉取失败：" + err.message;
    renderVpnResult(msg, true);
    saveVpnResult({ kind: "msg", text: msg, isError: true });
  }
}

function renderVpnAllUsers(groups, vpnCfg) {
  vpnUserResultBox.style.display = "block";
  vpnUserResultBox.classList.remove("error");
  vpnUserResultBox.textContent = "";

  const total = groups.reduce((n, g) => n + g.users.length, 0);
  const head = document.createElement("div");
  head.style.fontWeight = "700";
  head.textContent = `${total} 个在线用户`;
  vpnUserResultBox.appendChild(head);

  const listWrap = document.createElement("div");
  listWrap.style.maxHeight = "320px";
  listWrap.style.overflowY = "auto";
  listWrap.style.marginTop = "4px";

  groups.forEach(({ group, users, error }) => {
    const ghead = document.createElement("div");
    ghead.style.fontWeight = "700";
    ghead.style.marginTop = "6px";
    if (error) {
      ghead.style.color = "#b71c1c";
      ghead.textContent = `⚠️ ${group}：${error}`;
    } else {
      ghead.textContent = `📁 ${group}（${users.length} 人）`;
    }
    listWrap.appendChild(ghead);

    users.forEach((u) => {
      const rec = document.createElement("div");
      rec.className = "user-record";

      const info = document.createElement("div");
      info.className = "user-info";
      info.textContent = formatVpnUserLines(u).join(" | ");
      rec.appendChild(info);

      const banBtn = document.createElement("button");
      banBtn.className = "ban-btn";
      banBtn.textContent = "🚫 封禁VPN";
      const showIp = (u.vip && u.vip !== "0.0.0.0") ? u.vip : (u.nip || "");
      banBtn.addEventListener("click", (e) => openVpnBanWindow(u, showIp, group, banBtn, e, vpnCfg));
      rec.appendChild(banBtn);

      listWrap.appendChild(rec);
    });
  });

  vpnUserResultBox.appendChild(listWrap);
}

// 14. 新建 VPN 用户（文档 5.2.4）
// ============================================================
function renderVpnAddUserResult(message, isError) {
  vpnAddUserResultBox.style.display = "block";
  vpnAddUserResultBox.classList.toggle("error", !!isError);
  vpnAddUserResultBox.textContent = message;
}


function renderVpnUserRecords(ip, hits, errors, vpnCfg) {
  vpnUserResultBox.style.display = "block";
  vpnUserResultBox.classList.remove("error");
  vpnUserResultBox.textContent = "";

  const head = document.createElement("div");
  head.style.fontWeight = "700";
  head.textContent = `查到 ${hits.length} 条在线结果`;
  vpnUserResultBox.appendChild(head);

  if (errors.length) {
    const ew = document.createElement("div");
    ew.style.color = "#b71c1c";
    ew.textContent = `⚠️ 部分用户组查询失败：${errors[0].message}（结果可能不完整）`;
    vpnUserResultBox.appendChild(ew);
  }

  hits.forEach(({ group, user }) => {
    const rec = document.createElement("div");
    rec.className = "user-record";

    const info = document.createElement("div");
    info.className = "user-info";
    const lines = formatVpnUserLines(user);
    lines.push(`所属用户组：${group}`);
    info.textContent = lines.join("\n");
    rec.appendChild(info);

    const banBtn = document.createElement("button");
    banBtn.className = "ban-btn";
    banBtn.textContent = "🚫 封禁VPN";
    banBtn.addEventListener("click", (e) => openVpnBanWindow(user, ip, group, banBtn, e, vpnCfg));
    rec.appendChild(banBtn);

    vpnUserResultBox.appendChild(rec);
  });
}
