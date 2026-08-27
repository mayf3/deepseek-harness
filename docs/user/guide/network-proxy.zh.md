# 在网络代理后面运行 DSH

[English](network-proxy.md) | 中文

DSH 会把每一个出站请求——模型调用、web 搜索、页面抓取、走 HTTP 的 MCP 服务器与遥测——都经由标准代理环境变量所指定的代理发出。它在启动时读取这些变量，不需要其他配置。

## 导出环境变量

```sh
export HTTPS_PROXY=http://127.0.0.1:7890
export HTTP_PROXY=http://127.0.0.1:7890
```

把这两行写进 shell 配置，这样每次调用 `dsh` 都会继承它们。DSH 还会读取启动目录与 `$DSH_HOME` 下的 `.env` 文件，因此只对某个项目生效的代理可以写在那里；真实环境变量始终优先于文件。

需要凭据的代理把凭据写在 URL 里：`http://user:password@proxy.example:8080`。DSH 绝不会回显密码——诊断信息中出现的代理会显示用户名并掩去其余部分。

## 为什么浏览器走代理、终端却不走

这是最常见的意外，而且并非 DSH 特有。**根本不存在一个所有软件都遵循的"系统代理"**——实际上有三套互不相干的机制：

| 机制 | 谁会遵循 |
|---|---|
| 操作系统的代理设置 | Safari、绝大多数 macOS 原生应用、Chrome 与 Edge |
| `HTTP_PROXY` / `HTTPS_PROXY` 环境变量 | `curl`、`git`、`npm`、`pip` 以及 DSH |
| TUN 模式（虚拟网卡） | 所有程序，且对应用透明 |

Clash 这类代理软件里的"系统代理"开关只写第一套。浏览器会读到它，命令行工具则永远看不到。这就是为什么导出环境变量是一个独立步骤，也是为什么打开 TUN 模式后两者都能工作、且完全不需要变量。

DSH 不读取操作系统的代理设置。请导出环境变量，或使用 TUN 模式。

## 指定哪些目标保持直连

`NO_PROXY` 列出需要直连的主机：

```sh
export NO_PROXY=internal.example.com,.corp.example.com,registry.local
```

一个条目可匹配精确主机、`.suffix` 或 `*.suffix` 域名、可选的 `:port`，或用 `*` 匹配全部。

**CIDR 网段不生效。** 操作系统的绕过列表常含 `10.0.0.0/8` 或 `192.168.0.0/16` 这类条目；把它们复制进 `NO_PROXY` 不会有任何效果。请改用主机名或域名后缀。

不需要列出 `localhost` 或 `127.0.0.1`。DSH 始终绕过 loopback，否则它自己的 Web UI 与本地服务器都会经由代理并形成回环。

## 值得知道的限制

**不支持 SOCKS 代理。** `socks5://` 形式的值会在启动时被报告并跳过，DSH 转为直连。请把变量指向代理软件的 HTTP 端口——多数软件两者都提供，且 HTTP 端口通常就在相邻的端口号上。

**只设 `ALL_PROXY` 也够用。** DSH 会用它为两种协议兜底，尽管 Node 与 curl 在这一点上并不一致。显式设置 `HTTPS_PROXY` 仍然更清楚。

**做 TLS 拦截的企业代理需要它的证书。** 如果代理已经可达但请求仍报证书错误，请在启动前把 Node 指向你所在组织的 CA 包：

```sh
export NODE_EXTRA_CA_CERTS=/path/to/corporate-ca.pem
```

Node 只在进程启动时读取该变量，所以要在运行 `dsh` 之前导出。

**DSH 替你运行的工具遵循同一个代理。** bash 工具里的命令、`git`、`gh`，以及作为子进程启动的 MCP 服务器都会继承这些变量。子进程若本身是 Node 程序，则需 Node 22.21 或更高版本才会遵循；更旧的 Node 会直连。

## 验证是否生效

让 agent 抓取一个页面，同时观察代理软件的连接日志：

```sh
dsh --profile headless "fetch https://example.com and tell me the page title"
```

如果请求没有出现在那里，确认变量确实进入了 DSH 自己的环境：

```sh
env | grep -i proxy
```
