# Sign in 提交前清单

[English](sign-in-readiness.md) | 中文

本清单覆盖 welcome 分支的 DSH 登录、Platform 授权页面及两端联调，记录截至 2026-09-15 尚未完成或尚未充分验证的工作。

## 提交限制

2026-09-16，用户明确要求提交并推送当前分支，保存现阶段进度。本次进度提交获准在下列验收项仍未完成时进行；未完成项继续保留，不标记为已验收。

提交这批改动前，必须重新阅读本清单，确认所有待办均已完成并附有可核验的结果。存在任一未勾选项时不得提交；不能通过删除条目、搬到其他 TODO、仅记录“待产品确认”或把 mock 测试当成真实联调来清空清单。取消某项需求须有用户明确决定，并记录决定后才能勾选。此限制同样适用于本清单及其配套文档的单独提交。

完成后保留已勾选条目和验收依据，不删除清单。提交前重新检查 DSH 与 Platform 的相关 TODO，新增未完成项也须纳入此清单。

## 待办与完成条件

- [x] **Loopback 地址策略（DSH／Platform／后端）**：用户于 2026-09-15 明确后端支持 localhost，保留主机名及浏览器实际访问端口，不转换 IP。DSH、Platform 与 mock 已对齐精确 localhost 校验并拒绝仿冒域名。验收：2026-09-15，DSH 40 项账号测试及 lint 通过；Platform 72 项测试、两个类型检查及 lint 通过，覆盖原 URI 兑换成功、转换 IP 后兑换失败。本次决定不扩展 IPv6 字面量支持。
- [ ] **真实授权接口联调（后端／两端）**：在真实后端验证 auth_init 的 client_type 绑定、authorize 业务码、exchange 的 token／authorized_url、auth_cancel 的 verifier 校验和幂等、取消后申请及未兑换 code 失效。验证 desktop 与 web 来源不能在兑换时被覆盖；mock 实现不算后端完成证据。
- [ ] **真实 DSH token 使用与退登（后端／DSH）**：验证 current、余额、推理和文件接口均可使用真实 DSH token；验证推理／文件请求仍仅在允许的 api.deepseek.com 地址附带账号凭证。验证重启恢复、主动退登调用 Platform logout、本地凭证删除与远端撤销结果。使用独立测试账号，避免撤销日常账号的共享 dev token。
- [ ] **最新 Web 标签页流程联调（两端）**：使用 localhost:8081 跑通新标签页授权、成功自动关闭、exchange 失败关闭、原页失败弹窗和手动重试；覆盖超时、取消、自动关页受限、手动复制链接，以及 SSH 本地／远端端口不同和 IPv4／IPv6 监听配置下的 localhost 访问。确认不再打开第二个 Web UI，Web 完成页不显示桌面按钮。
- [ ] **原生客户端与安装包验收（DSH）**：在最新产物验证登录前 Host ready、登录后主界面加载、失败／超时恢复和窗口聚焦；在支持的发布平台验证安装包 dsh://open 注册、冷启动及已运行时唤起。既有旧版本手测不能替代最新改动验收。
- [ ] **业务错误产品定稿（产品／两端）**：已有 biz code 无需重新索要；确认每个业务错误的中英文文案、终态或可重试表现，并落实到页面及快照。其他 code／HTTP 错误沿用默认兜底。清理对应 product-error-ui TODO。
- [ ] **Platform 正式国际化（Platform／产品）**：将临时 harnessCopy 文案纳入正式翻译表并生成资源，替换临时读取方式；覆盖取消、Web 完成和手动关页文案，确认设计稿未提供的英文，清理对应 i18n TODO。
- [ ] **浏览器取消反馈要求（产品）**：明确 DSH 取消后，Platform 页面等用户再次点击授权才显示 CANCELED 是否可接受；若要求即时反馈，实现并验证通知／查询机制。无论采用哪种表现，本地都不能接受迟到授权结果。
- [ ] **“登录问题”链接去留（产品／Platform）**：核实原始需求；需要则提供并接入目标地址，不需要则移除相关占位或待办。不能把尚未确认的链接默认为必做功能。
- [ ] **最终变更审查与检查（两端）**：核对相关任务及两仓工作区的最终差异，排除无关文件和私有凭证；完成代码审查、相关行为测试／快照、类型／lint／构建及文档一致性检查，记录真实执行结果，并解决所有阻塞问题。完成本项不代表允许略过上方任一待办。
- [ ] **开发启动脚本提前退出（DSH）**：排查 start:desktop 在准备 primary runtime 时以成功状态退出、未启动 Electron 的问题；修复并验证标准启动入口，复用已有运行环境直接启动仅作为预览临时方案。

- [ ] **内嵌用量与充值（DSH / Platform）**：已按 Figma 节点 2554:28786 接入 Account 按钮、原生 48px 返回栏和 Platform 内嵌布局。验证真实 Electron/Platform 初始化、返回、刷新、失败及退登路径。2026-09-16 缩小到子节点后 TemPad 读取成功。启用充值前验证支付导航；原生视图阻止跨来源文档导航，并在系统浏览器中打开 HTTPS 弹出链接，不传递凭证。实现用量默认筛选前须提供 DSH key 的 trackingId；仅凭 token/authorized_url 无法识别该记录。私有 IPC 和 preload 初始化后的同步 getter 已有定向测试，但尚未通过端到端验收。

- [ ] **内嵌 Platform 复用设备身份（DSH / Platform / 后端）**：授权兑换、DSH 请求和内嵌 Platform 请求复用 DSH Host 已持久化的设备 ID。通过现有 Electron preload 初始化快照，将 deviceId/deviceModel 与 token 一起传入，并提供同步 window.dsh.getDeviceInfo() getter。内嵌 Platform 的 deviceProvider 从桥接读取，普通浏览器保留 localStorage UUID。接入 auth_token/check_device 补报前，先确认 auth_exchange 是否已完成设备登记。验证各处 x-device-id/x-device-model 一致，内嵌页不另生成浏览器设备 ID。

## 已实现的基线

账号资料与余额、左下角退登、私有 Platform URL 配置、共享 Host 回调端口、PKCE、本地取消决定权、auth_cancel、Electron 超时页、Web 登录弹窗和未登录 Settings 空态均已有实现。Web 失败关闭新标签页以及 desktop/web 来源区分也已实现；上方保留的是最终联调和发布验收，不是重复开发需求。

## 验收记录

每项完成时在该条目后记录日期、实现位置以及测试命令／结果或产品明确决定。地址策略条目已附完成依据；其他待办仍未完成。
