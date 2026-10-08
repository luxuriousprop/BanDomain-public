# API 入口嗅探器（Chrome / Edge 浏览器插件）

在一个网站上随便点点，插件自动把背后调用的 **API 入口**全部抓出来：
方法、路径、调用次数、状态码、请求参数样本、响应示例，一键导出给 Postman / Apifox 用。

## 功能

- **自动抓包**：劫持页面的 `fetch` / `XMLHttpRequest` / `sendBeacon`，记录每次调用的
  方法、完整 URL、请求体、响应体（前 4KB 样本）
- **按接口聚合**：`POST /api/v1/login` 这类相同接口自动合并，显示调用次数和状态码分布
- **只看 API**：自动过滤 js/css/图片等静态资源，聚焦真正的接口
- **详情查看**：点任意一条，看请求参数样本、格式化后的 JSON 响应示例
- **复制 cURL**：一键生成可直接粘贴到终端的 curl 命令
- **导出**：JSON（完整记录）/ Markdown（表格清单）
- **🔍 扫描 JS 找接口**：把页面引用的 JS（含内联）抓下来，用正则提取疑似接口路径，
  并标注哪些已在流量中实际观察到（✓）
- **📄 探测 OpenAPI 文档**：自动试探 `/openapi.json`、`/swagger.json` 等 5 个常见路径，
  找到的话可直接导入 Postman / Apifox

## 安装

Chrome 打开 `chrome://extensions`（Edge 是 `edge://extensions`）→ 打开开发者模式 →
「加载已解压的扩展程序」→ 选择本目录。

> 首次安装 Chrome 会提示"读取和更改您访问的网站上的所有数据"，
> 这是抓包类插件的必需权限（要注入脚本监听网络请求），本插件所有数据只存本机内存，
> 不上传到任何地方。

## 使用

1. 打开目标网站，点工具栏插件图标
2. 在网站上正常操作（登录、点菜单、查数据……），列表实时增长，图标徽标显示已发现接口数
3. 页面加载时发出的请求（如首屏数据）要点「↻ 刷新重抓」
4. 点一条记录看详情、复制 cURL；最后「导出 JSON / Markdown」

## 原理

- `page-hook.js` 以 MAIN world 在 `document_start` 注入页面，在页面自身脚本运行前
  劫持 `fetch`/`XHR`，通过 `postMessage` 把记录发给 `content.js`
- `content.js`（隔离世界）中转给 `background.js`（Service Worker），按
  `方法 + 路径` 聚合去重，popup 读取展示
- 静态扫描与 OpenAPI 探测由 `content.js` 按需执行，不常驻消耗资源

## 文件结构

```
api-sniffer/
├── manifest.json   # MV3 配置（Chrome / Edge 通用）
├── lib.js          # 纯函数库（popup 与 background 共用）
├── page-hook.js    # 注入页面主世界的抓包钩子
├── content.js      # 隔离世界：消息中转 + 静态扫描 + OpenAPI 探测
├── background.js   # Service Worker：按 tab 聚合记录
├── popup.html / popup.css / popup.js
├── icons/
└── README.md
```

## 已知限制

- 响应体只保留前 4KB 样本；二进制/流式响应记为 `[binary]` / `[stream]`
- Service Worker 被浏览器回收后内存中的记录会丢失（导出前别长时间闲置）
- `chrome://`、`edge://` 等内置页面无法注入脚本，这是浏览器限制
