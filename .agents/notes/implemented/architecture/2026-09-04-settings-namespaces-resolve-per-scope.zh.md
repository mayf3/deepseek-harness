# Agent Note：settings 命名空间按 scope 解析

Status: implemented

[English](2026-09-04-settings-namespaces-resolve-per-scope.md) | 中文

## 问题

settings seam 每个进程只允许注册一次命名空间。这对只存在一次的宿主行是对的，对 agent preset 却是坏的：同一个插件挂在多个常驻 scope 下，第二个 preset 的 `ctx.settings.register` 在 `ctx.inject` 延续里抛出"already registered"，这个 throw 消失在嵌套 fiber 中，第二个 preset 读到的是第一个的值。想让 `skill-filesystem` 只为 `research` preset 多扫一个根目录的人无处可说——文档每个命名空间只有一段，而插件管理器的按 preset 配置需要这样一段。

## 决定

**`dsh-scope` 给 scope 起名。** `createScope(ctx, key, { id })` 在 key 上记录一个稳定的名字，`scopeIdOf(ctx)` 沿上下文的父链回答最近的有名 scope，于是 agent 的上下文解析到它加入的 preset。`dsh-agent-presets` 把常驻 scope 命名为 `preset/<id>`。settings 只依赖 `dsh-scope`，从不依赖 preset。

**命名空间是一种 kind；注册是某个 scope 下的一个 instance。** `register` 经 `scopeIdOf(this.ctx)` 读取调用者的 scope——可追踪的服务代理把 `this.ctx` 绑到调用者——并把 instance 归档在其下，全局 scope 就是没有名字。同一 kind 的每个注册者必须带相同的 schema 信封（`schema.toJSON()` 用 seam 自己的相等谓词比较）；不同的信封大声失败，同一 scope 下的第二个 instance 也是。第一个注册者的 `validate` 与 `applies` 属于 kind。

**四层。** 一个 instance 按顺序解析 schema 默认值、自己的组合 `base`、文档的全局段、以及其 scope 的段（`scopes.<id>.<ns>`），沿用既有的字段级合并。全局写入重新解析该 kind 的每个 instance，各自按自身解析值门控，因此覆盖了被改字段的 scope 不会被打扰；scoped 写入只提交那个 instance。revision 按段记录，与注册分离，于是为尚无注册的 scope——还没有会话组合过的 preset——写入的段与其它段同样被版本化；只要 kind 存在，这样的写入就被接受并由共享 schema 判定。`scopes` 是保留的命名空间。

**按 scope 描述。** `describe()` 在全局 scope 下每个 kind 回答一条描述符；`describe({ scope })` 在某个具名 scope 下每个 kind 回答一条，附带 `registered`、该 scope 自己的 `user` 段，以及 `inherited`——没有该段时的值——让界面能把字段标为已覆盖、继承或默认。controller 的 `describe(scope?)` 与三个写入动词接受同样的可选尾随 `scope`，两个事件都把 scope 作为尾随参数携带、全局 instance 时缺席，这让每个既有监听器与转发事件载体保持不变。

**`skill-filesystem` 是第一个消费方。** 它的 `customSkillDirs` 以组合值为 base 经 `installSection` 解析；变化会替换 provider 的根目录并让目录失效，于是一个人可以在进程运行中从 settings 文档为某个 preset 添加一个根目录。

## 考虑过的替代方案

**每个 preset 一份 settings 文档。** 否决：文档是一个文件配一个 provider；每个 preset 再来一个文件，就要为同一格式再养一套 watcher、锁与重载路径。

**在 settings seam 内以 preset id 作为 instance 的键。** 否决：settings 就此认识了 preset；具名 scope 是通用形式，将来的具名 scope——工作区、团队——不花任何代价。

**每个 kind 只注册一次，每次读取传入 scope。** 否决：插件读取自己的句柄时并不知道自己跑在 preset 里；instance 的上下文已经说明它在哪。

## 后果

挂同一插件的两个 preset 各自保有值，静默碰撞消失。settings 界面可以在一个命名空间上提供"所有 preset"与"本 preset"。全局 `describe()` 仍然每个 kind 回答一行，因此既有设置页原样渲染，而插件管理器的页面（下一 PR）按 scope 读取。kind 的 `validate` 判定每个 instance，仅在 scope 下存在的 instance 在全局视图中呈现为 `registered: false`。

## 测试

`packages/settings/settings/tests/scopes.spec.ts` 钉住具名与继承 scope 下的注册、kind 级 schema 一致性、重复与保留名拒绝、scoped 解析、带 deep-equal 门控的全局写入扇出、经句柄与 provider 的 scoped 写入、按段的 revision 与冲突、对未注册 scope 的写入、外部 scope 编辑、畸形 scope 段，以及带脱敏的 scoped 与全局描述。`packages/settings/settings-file/tests/scopes.spec.ts` 钉住 YAML 与 JSON 中 `scopes.<id>.<ns>` 的布局且注释完好。`packages/api/settings-controller/tests/settings-controller.host.spec.ts` 钉住 scoped 的 Remote 读写；`packages/core/scope/tests/scope.spec.ts` 钉住具名 scope 解析；`packages/preset/agent-presets/tests/overlay.spec.ts` 钉住 preset 的 scope 名；`packages/skill/skill-filesystem/tests/skill-filesystem.spec.ts` 钉住经 settings 的根目录在线变更。
