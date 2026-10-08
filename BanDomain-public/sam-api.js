// sam-api.js — BanDomain 插件共享的 SAM SOAP 接口层
// 被 popup.html、ban.html 共同加载，也被 background Service Worker 经 importScripts 加载；
// 仅依赖 fetch/TextEncoder/chrome.storage，不直接操作页面 DOM。
// XML 解析为双模式：页面环境用 DOMParser；Service Worker 没有 DOMParser，
// 退化为内置的极简 XML 解析器（节点形态与 DOM 对齐：local/getAttribute/parentNode/
// childNodes/textContent/getElementsByTagNameNS），足够解析 SAM 的响应报文。


const SAM_FALLBACK_NS = "http://api.spl.ruijie.com/";

const SOAP_ENV_NS = "http://schemas.xmlsoap.org/soap/envelope/";

const SAM_METHOD_DEFAULTS = {
  queryOnlineUser: { wrapper: "param" },
  addInhibit: { wrapper: "params" },
  queryInhibit: { wrapper: "param" },
  deleteInhibit: { wrapper: null } // 扁平：直接 <uuid>
};

const BAN_DEFAULT_DAYS = 1;

const BAN_DEFAULT_MEMO = "您的终端存在木马病毒活动已被封禁，请下载火绒杀毒软件查杀后联系管理员！";

const BAN_MEMO_MAX_BYTES = 250;

const BAN_LIST_LIMIT = 100;

const samOpCache = {};

function samOpKey(endpoint, method) { return endpoint + "::" + method; }

const ONLINE_USER_FIELDS = [
  ["userId", "用户名"],
  ["userName", "姓名"],
  ["userIpv4", "IPv4"],
  ["userIpv6", "IPv6"],
  ["userMac", "MAC"],
  ["usergroupId", "用户组"],
  ["packageName", "套餐"],
  ["nasIp", "NAS IP"],
  ["ssid", "SSID"],
  ["onlineTime", "上线时间"],
  ["accessType", "接入类型"]
];

const ACCESS_TYPE_MAP = {
  "1": "有线1x接入", "2": "有线WebPortal接入", "3": "无线1x接入",
  "4": "无线WebPortal接入", "5": "VPN拨号接入", "8": "Web纯准出接入",
  "10": "MAC快速接入", "13": "智能终端1x接入",
  "14": "智能终端WebPortal接入", "15": "有线标准Portal接入"
};

function isValidIp(s) {
  const v4 = /^(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/;
  const v6 = /^(([0-9a-fA-F]{1,4}:){7}[0-9a-fA-F]{1,4}|([0-9a-fA-F]{1,4}:){1,7}:|([0-9a-fA-F]{1,4}:){1,6}:[0-9a-fA-F]{1,4}|::)$/;
  return v4.test(s) || v6.test(s);
}

function isIpv6(s) {
  return s.includes(":");
}

function xmlEscape(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function basicAuthHeader(user, pass) {
  const bytes = new TextEncoder().encode(`${user}:${pass}`);
  let bin = "";
  bytes.forEach((b) => { bin += String.fromCharCode(b); });
  return "Basic " + btoa(bin);
}

async function discoverSamMethod(endpoint, authHeader, method) {
  const key = samOpKey(endpoint, method);
  if (samOpCache[key]) return samOpCache[key];

  const def = SAM_METHOD_DEFAULTS[method] || { wrapper: "params" };
  const fallback = {
    namespace: SAM_FALLBACK_NS, wrapper: def.wrapper, qualified: false,
    wsdlStatus: "未获取（使用经确认的缺省结构）"
  };

  // 优先使用本地缓存（v1.3.3 起按 endpoint::method 存储；兼容旧版仅按 endpoint 的键）
  try {
    const stored = await chrome.storage.local.get(["samOpCache"]);
    const cache = stored.samOpCache || {};
    const hit = cache[key] || (method === "queryOnlineUser" ? cache[endpoint] : null);
    if (hit && hit.namespace) {
      samOpCache[key] = { ...hit, wsdlStatus: "使用本地缓存的发现结果" };
      return samOpCache[key];
    }
  } catch {
    // 存储不可用则继续走 ?wsdl
  }

  const controller = new AbortController();
  const tid = setTimeout(() => controller.abort(), 8000);
  try {
    const headers = authHeader ? { "Authorization": authHeader } : {};
    const resp = await fetch(endpoint + "?wsdl", { headers, signal: controller.signal });
    const wsdlStatus = `HTTP ${resp.status}`;
    if (!resp.ok) {
      samOpCache[key] = { ...fallback, wsdlStatus: wsdlStatus + "（使用经确认的缺省结构）" };
      return samOpCache[key];
    }
    const text = await resp.text();
    const doc = parseXmlDocument(text);
    if (hasParserError(doc)) {
      samOpCache[key] = { ...fallback, wsdlStatus: "返回非 XML（使用经确认的缺省结构）" };
      return samOpCache[key];
    }

    const nsM = text.match(/targetNamespace="([^"]+)"/);
    const namespace = (nsM && nsM[1]) || SAM_FALLBACK_NS;

    const schema = elByLocalName(doc, "schema");
    const qualified = !!schema && schema.getAttribute("elementFormDefault") === "qualified";

    // 找顶层的 <element name="{method}">（schema 的直接子节点）
    let opEl = null;
    const elements = doc.getElementsByTagNameNS("*", "element");
    for (const el of elements) {
      if (el.getAttribute("name") === method && el.parentNode === schema) {
        opEl = el;
        break;
      }
    }
    if (!opEl) {
      for (const el of elements) {
        if (el.getAttribute("name") === method) { opEl = el; break; }
      }
    }

    // 取 sequence 下子元素的实际名称作为包裹层名；
    // - 单个复杂类型子元素 => 它是包裹层（如 <param>/<params>）
    // - 单个简单类型子元素（如 xs:string 的 uuid）=> 它本身就是字段，无需再包裹
    // - 多个子元素 => 扁平字段（无包裹层）；找不到 => 缺省值
    let wrapper = def.wrapper;
    if (opEl) {
      const seq = elByLocalName(opEl, "sequence") || opEl;
      const children = [];
      for (const child of seq.childNodes) {
        if (child.nodeType === 1 && child.localName === "element" && child.getAttribute("name")) {
          children.push({ name: child.getAttribute("name"), type: child.getAttribute("type") || "" });
        }
      }
      if (children.length === 1) {
        wrapper = /^(xs|xsd):/.test(children[0].type) ? null : children[0].name;
      } else if (children.length > 1) {
        wrapper = null;
      }
    }
    samOpCache[key] = { namespace, wrapper, qualified, wsdlStatus };
    // 成功发现后缓存到本地，下次直接复用
    try {
      const stored = await chrome.storage.local.get(["samOpCache"]);
      const cache = stored.samOpCache || {};
      cache[key] = { namespace, wrapper, qualified };
      await chrome.storage.local.set({ samOpCache: cache });
    } catch {
      // 缓存失败不影响本次查询
    }
  } catch (err) {
    samOpCache[key] = { ...fallback, wsdlStatus: `获取异常: ${err.name === "AbortError" ? "超时" : err.message}（使用经确认的缺省结构）` };
  } finally {
    clearTimeout(tid);
  }
  return samOpCache[key];
}

async function discoverSamOperation(endpoint, authHeader) {
  return discoverSamMethod(endpoint, authHeader, "queryOnlineUser");
}

function buildSoapEnvelope(method, op, fieldsXml) {
  const { namespace, wrapper, qualified } = op;
  const p = qualified ? "ns:" : "";
  const body = wrapper
    ? `<${p}${wrapper}>${fieldsXml}</${p}${wrapper}>`
    : fieldsXml;
  return `<?xml version="1.0" encoding="UTF-8"?>` +
    `<soapenv:Envelope xmlns:soapenv="${SOAP_ENV_NS}" xmlns:ns="${xmlEscape(namespace)}">` +
    `<soapenv:Body><ns:${method}>${body}</ns:${method}></soapenv:Body></soapenv:Envelope>`;
}

function buildQueryOnlineUserEnvelope(ip, op) {
  const p = op.qualified ? "ns:" : "";
  const ipField = isIpv6(ip) ? "userIpv6" : "userIpv4";
  const fieldsXml =
    `<${p}${ipField}>${xmlEscape(ip)}</${p}${ipField}>` +
    `<${p}offSet>0</${p}offSet><${p}limit>10</${p}limit>`;
  return buildSoapEnvelope("queryOnlineUser", op, fieldsXml);
}

function formatLocalDateTime(d) {
  const p2 = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}T${p2(d.getHours())}:${p2(d.getMinutes())}:${p2(d.getSeconds())}`;
}

function banValidTime(days) {
  return formatLocalDateTime(new Date(Date.now() + days * 86400000));
}

function memoByteLength(memo) {
  return new TextEncoder().encode(memo).length;
}

async function samSoapPost(endpoint, authHeader, envelope, timeoutMs = 10000) {
  const controller = new AbortController();
  const tid = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const resp = await fetch(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "text/xml; charset=utf-8",
        "SOAPAction": '""',
        "Authorization": authHeader
      },
      body: envelope,
      signal: controller.signal
    });
    if (resp.status === 401 || resp.status === 403) {
      throw new Error(`SAM 认证失败（HTTP ${resp.status}）：请检查设置中的用户名/密码`);
    }
    if (!resp.ok) {
      throw new Error(`SAM HTTP 异常状态码: ${resp.status}`);
    }
    return await resp.text();
  } finally {
    clearTimeout(tid);
  }
}

async function getSamConfig() {
  const cfg = await chrome.storage.local.get(["samUrl", "samUser", "samPass"]);
  const samUrl = (cfg.samUrl || "").trim().replace(/\/+$/, "");
  const samUser = (cfg.samUser || "").trim();
  const samPass = cfg.samPass || "";
  if (!samUrl || !samUser || !samPass) {
    throw new Error("请先在设置中配置 SAM 接口地址、用户名与密码");
  }
  return { samUrl, samUser, samPass, authHeader: basicAuthHeader(samUser, samPass) };
}

// ---------- XML 解析双模式 ----------
// 页面环境用 DOMParser；Service Worker 没有 DOMParser，退化为内置的极简 XML 解析器
// （节点形态与 DOM 对齐：local/getAttribute/parentNode/childNodes/textContent/
// getElementsByTagNameNS），足够解析 SAM 的响应报文。
function parseXmlDocument(xmlText) {
  if (typeof DOMParser !== "undefined") {
    return new DOMParser().parseFromString(xmlText, "text/xml");
  }
  return simpleXmlParse(xmlText); // Service Worker 环境
}

function hasParserError(doc) {
  const list = doc.getElementsByTagName ? doc.getElementsByTagName("parsererror") : [];
  return list.length > 0;
}

function simpleXmlParse(xml) {
  const s = String(xml)
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<\?[\s\S]*?\?>/g, "")
    .replace(/<![A-Z]+[\s\S]*?>/g, "")
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1");
  const docNode = makeXmlNode("#document", null);
  const stack = [docNode];
  const tagRe = /<(\/?)([A-Za-z_][\w:.\-]*)([^<>]*?)(\/?)>/g;
  let m, last = 0, ok = true;
  while ((m = tagRe.exec(s))) {
    const text = s.slice(last, m.index);
    if (text && text.trim()) {
      stack[stack.length - 1].childNodes.push(makeXmlText(text, stack[stack.length - 1]));
    }
    last = tagRe.lastIndex;
    const isClose = m[1] === "/";
    const qname = m[2];
    const local = qname.indexOf(":") >= 0 ? qname.split(":").pop() : qname;
    if (isClose) {
      let idx = stack.length - 1;
      while (idx > 0 && stack[idx].local !== local) idx--;
      if (idx === 0) { ok = false; break; }
      stack.length = idx;
    } else {
      const node = makeXmlNode(local, stack[stack.length - 1]);
      const attrRe = /([A-Za-z_][\w:.\-]*)\s*=\s*"([^"]*)"/g;
      let am;
      while ((am = attrRe.exec(m[3] || ""))) node.attrs[am[1]] = am[2];
      stack[stack.length - 1].childNodes.push(node);
      if (m[4] !== "/") stack.push(node);
    }
  }
  const tail = s.slice(last);
  if (tail && tail.trim()) {
    stack[stack.length - 1].childNodes.push(makeXmlText(tail, stack[stack.length - 1]));
  }
  if (!ok || stack.length !== 1) docNode.parserError = true;
  return docNode;
}

function makeXmlNode(local, parent) {
  const node = {
    nodeType: 1,
    local,
    parentNode: parent || null,
    childNodes: [],
    attrs: {},
    getAttribute(name) {
      return Object.prototype.hasOwnProperty.call(this.attrs, name) ? this.attrs[name] : null;
    },
    getElementsByTagName(name) {
      return this.getElementsByTagNameNS("*", name);
    },
    getElementsByTagNameNS(ns, name) {
      const out = [];
      (function walk(n) {
        for (const c of n.childNodes) {
          if (c.nodeType === 1) {
            if (c.local === name) out.push(c);
            walk(c);
          }
        }
      })(this);
      return out;
    }
  };
  Object.defineProperty(node, "textContent", {
    get() {
      let t = "";
      for (const c of this.childNodes) {
        t += c.nodeType === 3 ? c.text : c.textContent;
      }
      return t;
    }
  });
  return node;
}

function makeXmlText(text, parent) {
  return { nodeType: 3, local: "#text", text, parentNode: parent || null, childNodes: [] };
}

// 查询指定 IP 的在线用户（纯逻辑，供 popup 查询按钮与后台右键菜单共用）。
// 成功返回 OnlineUserInfo[]（可能为空数组）；失败抛错（未配置/网络超时/SAM 业务拒绝）。
async function queryOnlineUsersByIp(samUrl, authHeader, ip) {
  const op = await discoverSamMethod(samUrl, authHeader, "queryOnlineUser");
  const envelope = buildQueryOnlineUserEnvelope(ip, op);
  const respText = await samSoapPost(samUrl, authHeader, envelope);
  return parseQueryOnlineUserResponse(respText);
}

// ---------- 多 SAM（内网双 SAM 简化版：两台共用一套账号密码） ----------
// 读取配置的多台 SAM，返回 [{ name, url, authHeader }]；未填地址的跳过。
// 至少配一台地址 + 用户名 + 密码，否则抛错（调用方据此提示去设置）。
async function getSamConfigs() {
  const cfg = await chrome.storage.local.get(["samUrl", "samUrl2", "samUser", "samPass"]);
  const samUser = (cfg.samUser || "").trim();
  const samPass = cfg.samPass || "";
  if (!samUser || !samPass) {
    throw new Error("请先在设置中配置 SAM 用户名与密码");
  }
  const list = [];
  const url1 = (cfg.samUrl || "").trim();
  const url2 = (cfg.samUrl2 || "").trim();
  if (url1) list.push({ name: "SAM-1", url: url1, authHeader: basicAuthHeader(samUser, samPass) });
  if (url2) list.push({ name: "SAM-2", url: url2, authHeader: basicAuthHeader(samUser, samPass) });
  if (!list.length) {
    throw new Error("请先在设置中配置 SAM 接口地址");
  }
  return list;
}

// 并行查询多台 SAM 的在线用户。
// 返回 { results: [{sam, users}], errors: [{sam, message}] }，单台失败不影响其他。
async function queryOnlineUsersMulti(samList, ip) {
  const settled = await Promise.allSettled(
    samList.map(async (sam) => ({
      sam,
      users: await queryOnlineUsersByIp(sam.url, sam.authHeader, ip)
    }))
  );
  const results = [], errors = [];
  settled.forEach((r, i) => {
    if (r.status === "fulfilled") results.push(r.value);
    else errors.push({ sam: samList[i], message: errMsgOf(r.reason) });
  });
  return { results, errors };
}

// 并行查询多台 SAM 的黑名单规则；返回的 rule 会带上 _sam（来源 SAM），解封时打回原 SAM。
async function queryInhibitMulti(samList, limit) {
  const settled = await Promise.allSettled(
    samList.map(async (sam) => {
      const op = await discoverSamMethod(sam.url, sam.authHeader, "queryInhibit");
      const xml = await samSoapPost(
        sam.url, sam.authHeader,
        buildSoapEnvelope("queryInhibit", op, `<offSet>0</offSet><limit>${limit}</limit>`)
      );
      return { sam, rules: parseQueryInhibitResponse(xml) };
    })
  );
  const results = [], errors = [];
  settled.forEach((r, i) => {
    if (r.status === "fulfilled") {
      r.value.rules.forEach((rule) => { rule._sam = r.value.sam; });
      results.push(r.value);
    } else {
      errors.push({ sam: samList[i], message: errMsgOf(r.reason) });
    }
  });
  return { results, errors };
}

function errMsgOf(reason) {
  if (!reason) return "未知错误";
  if (reason.name === "AbortError") return "连接超时";
  return reason.message || String(reason);
}

function parseSoapReturn(xmlText, responseName) {
  const doc = parseXmlDocument(xmlText);
  if (hasParserError(doc)) {
    throw new Error("SAM 返回了非法的 XML 响应");
  }
  const fault = elByLocalName(doc, "Fault");
  if (fault) {
    throw new Error(`SAM 接口异常: ${textOf(fault, "faultstring") || "未知错误"}`);
  }
  const respEl = elByLocalName(doc, responseName);
  if (!respEl) {
    throw new Error(`SAM 响应中缺少 ${responseName} 节点`);
  }
  const scope = elByLocalName(respEl, "return") || respEl;
  const errorCode = textOf(scope, "errorCode");
  const errorMessage = textOf(scope, "errorMessage");
  if (errorCode !== "0") {
    throw new Error(`SAM 业务拒绝(errorCode=${errorCode || "?"}): ${errorMessage || "无详细信息"}`);
  }
  return scope;
}

function parseQueryInhibitResponse(xmlText) {
  const scope = parseSoapReturn(xmlText, "queryInhibitResponse");
  const rules = [];
  const infos = scope.getElementsByTagNameNS("*", "inhibitInfos");
  for (const info of infos) {
    if (info.parentNode !== scope) continue;
    rules.push({
      inhibitUuid: textOf(info, "inhibitUuid"),
      userId: textOf(info, "userId"),
      isValid: textOf(info, "isValid"),
      validTime: textOf(info, "validTime"),
      memo: textOf(info, "memo"),
      userIpv4: textOf(info, "userIpv4"),
      userMac: textOf(info, "userMac")
    });
  }
  return rules;
}

function isRuleActive(rule) {
  if (rule.isValid !== "1" || !rule.validTime) return false;
  const t = new Date(rule.validTime).getTime();
  return !isNaN(t) && t > Date.now();
}

function formatValidTime(s) {
  const t = String(s || "").trim();
  if (!t) return "—";
  const m = t.match(/^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})/);
  return m ? `${m[1]} ${m[2]}` : t;
}

function elByLocalName(parent, name) {
  const list = parent.getElementsByTagNameNS("*", name);
  return list.length ? list[0] : null;
}

function textOf(parent, name) {
  const el = elByLocalName(parent, name);
  return el ? el.textContent.trim() : "";
}

function parseQueryOnlineUserResponse(xmlText) {
  const scope = parseSoapReturn(xmlText, "queryOnlineUserResponse");

  // onlineUserInfos 为数组：取 return 下的直接子元素，每项即一条在线记录
  const records = [];
  const infos = scope.getElementsByTagNameNS("*", "onlineUserInfos");
  for (const info of infos) {
    if (info.parentNode !== scope) continue;
    const rec = {};
    for (const [key] of ONLINE_USER_FIELDS) {
      rec[key] = textOf(info, key);
    }
    records.push(rec);
  }
  return records;
}

function formatOnlineUsers(ip, users) {
  const lines = [`IP ${ip} 共找到 ${users.length} 条在线记录：`];
  users.forEach((u, idx) => {
    if (users.length > 1) lines.push(`── 记录 ${idx + 1} ──`);
    for (const [key, label] of ONLINE_USER_FIELDS) {
      let v = u[key] || "";
      if (!v) continue;
      if (key === "accessType") {
        v = `${v}（${ACCESS_TYPE_MAP[v] || "未知类型"}）`;
      }
      lines.push(`${label}：${v}`);
    }
  });
  return lines.join("\n");
}

function formatOneUserLines(u, showIndex) {
  const lines = [];
  if (showIndex >= 0) lines.push(`── 记录 ${showIndex + 1} ──`);
  for (const [key, label] of ONLINE_USER_FIELDS) {
    let v = u[key] || "";
    if (!v) continue;
    if (key === "accessType") {
      v = `${v}（${ACCESS_TYPE_MAP[v] || "未知类型"}）`;
    }
    lines.push(`${label}：${v}`);
  }
  return lines;
}


// 执行封禁（纯逻辑，无 DOM 依赖）：
// 先 queryInhibit 防重复，再 addInhibit；成功返回 { validTime }，失败抛错。
// days: 整数天数；memo: 提示信息（调用方保证 ≤250 字节）。
async function executeBan(samUrl, authHeader, userId, days, memo) {
  const qOp = await discoverSamMethod(samUrl, authHeader, "queryInhibit");
  const qXml = await samSoapPost(
    samUrl, authHeader,
    buildSoapEnvelope("queryInhibit", qOp,
      `<userId>${xmlEscape(userId)}</userId><offSet>0</offSet><limit>10</limit>`)
  );
  const existed = parseQueryInhibitResponse(qXml).find(isRuleActive);
  if (existed) {
    const err = new Error(`该用户已在黑名单中（有效期至 ${formatValidTime(existed.validTime)}），不再重复添加`);
    err.code = "ALREADY_BANNED";
    throw err;
  }
  const aOp = await discoverSamMethod(samUrl, authHeader, "addInhibit");
  const validTime = banValidTime(days);
  const fieldsXml =
    `<userId>${xmlEscape(userId)}</userId>` +
    `<isValid>1</isValid>` +
    `<validTime>${xmlEscape(validTime)}</validTime>` +
    `<memo>${xmlEscape(memo)}</memo>`;
  const aXml = await samSoapPost(samUrl, authHeader, buildSoapEnvelope("addInhibit", aOp, fieldsXml));
  parseSoapReturn(aXml, "addInhibitResponse"); // 仅校验 errorCode
  return { validTime };
}
