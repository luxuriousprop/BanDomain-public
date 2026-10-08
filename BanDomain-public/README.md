# 网络运维工具

Chrome / Edge 浏览器扩展，为网络运维人员提供一键式的域名封禁、SAM 在线用户管理与深信服 SSL VPN 用户管理能力。

## 功能特性

### 域名封禁（DNS RPZ）

- 单个 / 批量域名一键封禁与解封
- 调用内网 DNS 的 RPZ 接口，支持 TTL 与重定向目标配置
- 批量操作逐域名回显结果

### SAM 在线用户管理

- 按 IP 查询在线用户（支持双 SAM 并行查询，适用于账号全网唯一的场景）
- 在线用户一键封禁：黑名单规则（支持封禁天数与自定义通知文案）、封禁前防重复检查
- 已封禁名单查看与一键解封

### SSL VPN 用户管理（深信服 OpenAPI）

- 按 IP 查询在线用户（接入 IP / 虚拟 IP 双匹配）
- 在线用户封禁：禁用账号 + 踢下线，独立确认窗口，两击确认
- 新建 VPN 用户：用户名 / 密码 / 过期日期必填，自动继承所属组认证与策略
- 用户续期：设置新的过期时间，确认前回显用户当前参数供核对

### 通用

- 查询结果在弹窗失焦关闭后可恢复（会话级缓存，不含密钥）
- 所有密钥仅保存在本机，代码零硬编码

## 安装

1. 从 Releases 下载最新 `BanDomain-fixed-x.y.z.zip` 并解压；
2. 打开 `chrome://extensions`，开启右上角"开发者模式"；
3. 点击"加载已解压的扩展程序"，选择解压后的目录。

## 配置

首次安装后点击工具栏图标，按提示打开设置面板：

### 域名封禁

- **API 地址**：内网 DNS 的 RPZ 接口地址
- **Token**：接口鉴权 Token（仅保存在本机）

### SAM

- **SAM 接口地址**：如 `http://SAM_IP:8080/sam/services/samapi`
- **SAM2 接口地址**（可选）：第二台 SAM，填写后双机并行查询
- **账号 / 密码**：需具备用户查询与黑名单管理权限的 SAM 账号

### VPN

- **VPN 地址**：如 `https://vpn.example.com:4430`
- **API 密钥 Skey**：在 VPN 控制台获取（仅保存在本机）
- **用户组**：每行一个用户组全路径，如 `/默认用户组`（路径末尾无斜杠，以设备实际配置为准）

## 使用说明

- **查在线用户**：在对应查询框输入 IP → 查询；VPN 查询同时匹配接入 IP 与虚拟 IP（`0.0.0.0` 视为未分配，不参与匹配）。
- **更多菜单**：查询行右侧的"更多 ▾"收纳低频功能。SAM 侧：已封禁名单；VPN 侧：在线用户查询（全部在线用户）、新建用户、用户续期。
- **封禁**：点击记录旁的封禁按钮，在独立确认窗内核对用户信息后两击确认。SAM 封禁为黑名单规则（可设天数）；VPN 封禁为禁用账号 + 踢下线（恢复需在 VPN 控制台手动重新启用）。
- **新建 VPN 用户**：更多 → 新建用户，用户名 / 密码 / 过期日期必填，所属组默认 `/默认用户组`。
- **用户续期**：更多 → 用户续期，第一下确认时回显该用户当前参数（描述、手机号、组 id、当前过期时间、最近登录），核对后第二下执行。注意选择正确的所属组。

## 接口说明

- **SAM**：Ruijie SAM API V2（SOAP）：`queryOnlineUser`、`queryInhibit`、`addInhibit`、`deleteInhibit`；WSDL 结构按服务端实际返回自适应。
- **VPN**：深信服 SSL VPN OpenAPI：`GetOnlineUserCloud`、`ExGetUserInfo`、`ExtSetUserEnable`、`KillOnlineUserCloud`、`AddUserCloud`、`UpdateUserCloud`；鉴权为 `sha256(Sparams + timestamp + Skey)`。
- **域名**：内网 DNS RPZ HTTP 接口（`AddDnsRpz`）。

## 安全说明

- 所有密钥（Token、SAM 账号密码、VPN Skey）仅通过设置页配置，保存在浏览器本地存储，不会出现在代码、安装包、日志中；
- 扩展只向你配置的地址发起网络请求。

## 目录结构

```text
popup.html / popup.js        主面板
sam-api.js                   SAM 接口封装
ban.html / ban.js            SAM 封禁确认窗
vpn-api.js                   VPN 接口封装（含请求签名）
vpnban.html / vpnban.js      VPN 封禁确认窗
vpnadduser.html / .js        新建 VPN 用户窗口
vpnrenew.html / .js          VPN 用户续期窗口
background.js                后台（右键菜单等）
tests/                       单元测试：node tests/*.test.js
```

## 版本历史（简）

- v1.13.x：续期功能完善（确认前回显用户参数、所属组选择）、SAM 查询行"更多"菜单
- v1.12.x：新建用户密码 / 过期日期必填；删除实测冗余的"生效"逻辑
- v1.11.x："更多"下拉菜单、蓝色主按钮统一
- v1.10.x：新建 VPN 用户；封禁前取接口最新用户信息
- v1.8.x–v1.9.x：VPN 查询排错（虚拟 IP 匹配、错误码映射）与重构
- v1.8.0：VPN 在线用户查询与封禁
- v1.7.x：双 SAM 并行查询

## 注意事项

- SAM 若使用 HTTPS 且服务端为老旧自签名证书（如 RSA-MD5），Chrome 会直接拒绝连接，需服务端更换合规证书；
- 续期（编辑用户）接口的 `parent_group` 参数会**变更用户所属组**，务必选择用户实际所在的组；
- 深信服文档中 `gqsj` 为反逻辑：`1`=关闭过期，`0`=开启过期（此时 `ex_time` 生效）。
