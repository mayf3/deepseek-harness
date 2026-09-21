# 手册：添加设置页

[English](adding-a-settings-card.md) | 中文

插件如何把自己的配置放到 Web 客户端的插件页上，以及如何向那里的其他插件页面贡献内容。这条路径不需要改动本仓库：Host 服务每一个已注册的设置命名空间，插件页声明了页面或贡献要注册进去的 slot。

社区组合包的两个半侧放在一个包里——宿主半侧在 `src/`，浏览器半侧在 `src/client/`，导出为 `./client` 并用 `dsh.client` 声明。包本身带不了浏览器半侧的内置插件，则把页面做成一个伴生客户端包；[`packages/client/ui-settings-shell`](../../packages/client/ui-settings-shell) 是模板。

## 1. 注册命名空间（宿主半侧）

命名空间是连接键，选定一次，两个半侧拼写一致。已有 `cordis.yml` 条目的消费者应通过 `ctx.settings.installSection()` 注册，它把条目铺在用户文档之下，并在没有挂载设置提供方时照常工作：

```ts
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-settings'
import z from '@deepseek-ai/schemastery'

declare function assertReachable(endpoint: string | undefined): void
declare function rebuildFromSettings(config: Config): void

export const MY_PLUGIN_NS = 'my-plugin'

export interface Config {
  endpoint?: string
  retries?: number
}

export const Config: z<Config> = z.object({
  endpoint: z.string(),
  retries: z.number().step(1).min(0).default(3),
})

export function apply(ctx: Context, config: Config) {
  let source = () => config
  ctx.inject(['settings'], (settingsCtx) => {
    settingsCtx.settings.installSection(ctx, MY_PLUGIN_NS, Config, config, {
      // Constraints the schema cannot express refuse the write, not the next use.
      validate: value => void assertReachable(value.endpoint),
      setSource: (current) => { source = current },
      onChange: () => { rebuildFromSettings(source()) },
    })
  })
}
```

字段上的 `role('secret')` 让它的值不出现在任何响应里；页面改经 `credentials` 域写入这类字段。`applies: 'restart'` 告诉配置界面：所有者要到下次启动才响应更改。

## 2. 注册页面（浏览器半侧）

页面注册进插件页的某个配置 slot，并拥有其中的一切——控件、文案和样式。组合包自己的配置进 `plugins.bundle.config`，以包名为键；组合包声明的某一行的配置进 `plugins.row.config`，以 `<包名>#<行 id>` 为键，这会给该行一个打开行页的配置控件。页面向每个条目索取两种视图：`summary` 是标题下的一句话，`page` 是表单。

表单通过 `ctx.settingsScope` 读写，每次写入都以读取时的修订号作栅栏。`ui-primitives` 套件提供暂存编辑模型和控件，页面只需声明字段并渲染：

```ts ignore-check
import type { Context as ClientContext } from '@deepseek-ai/cordis'
// Type-only: the Plugins page's slot declarations and the settings scope.
// Cross-plugin collaboration goes through cordis services; a value import
// fails the client bundle-purity gate.
import type {} from '@deepseek-ai/dsh-client-ui-plugin-manager/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import { SettingsFormModel, settingsNumberField, settingsTextField } from '@deepseek-ai/dsh-client-ui-primitives'

export const inject = ['slots', 'locale', 'settingsScope']

export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register('myPlugin', { zh, en }))
  const form = new SettingsFormModel(
    ctx.settingsScope.bind({ namespace: 'my-plugin' }),
    [settingsTextField('endpoint'), settingsNumberField('retries')],
  )
  const store = form.bind(() => ({ ...form.shell(), endpoint: form.field('endpoint'), retries: form.field('retries') }))
  ctx.slots.inject('plugins.bundle.config', () => ctx.slots.register({
    name: 'plugins.bundle.config',
    key: '@acme/dsh-my-plugin',
    locale: 'myPlugin',
    inject: () => ({ hooks: { myPluginForm: store }, ...form.actions() }),
  }, MyPluginPage))
}
```

`MyPluginPage` 在 `view === 'summary'` 时渲染 `t('summary')`，在 `page` 时渲染一个包着 `SettingsValueField` 控件的 `SettingsForm`，并以 `labels` 把文案交给框架。字段是否被覆盖看它在原始用户层里是否存在，而不看它的值；重置会清除该字段，让它重新继承组合层。只有保存才写入，离开页面即丢弃所有草稿。

## 3. 向其他插件的页面贡献内容

对某个不属于自己的组合包、行或官方插件有话要说的插件，注册进 `plugins.detail.actions`（页头的控件）、`plugins.detail.badge`（标题旁的标签）或 `plugins.detail.section`（页面自身内容之下的区块）。每个条目都以页面的 `subject` 渲染——`{ kind: 'bundle', pkg }`、`{ kind: 'row', pkg, row }` 或 `{ kind: 'item', id }`——对无话可说的 subject 返回 null：

```tsx ignore-check
ctx.slots.inject('plugins.detail.badge', () => ctx.slots.register({
  name: 'plugins.detail.badge',
  id: 'acme-update',
  locale: 'acmeUpdate',
}, ({ t, subject }) => subject.kind === 'bundle' && hasUpdate(subject.pkg) ? <Tag tone="info">{t('update')}</Tag> : null))
```

## 4. 浏览器半侧挂在哪里

浏览器半侧由[客户端模块系统](../../packages/client/modules)送到页面：它扫描已启用的 Loader 条目，找出声明了 `dsh.client` 的包，送出每个包构建好的 `./client` 导出——但它只把一个包的半侧挂在说明符恰为裸包名的那一行上。从子路径导出挂载的行永远不带半侧，因此把一个包拆成多行的组合包，其半侧留在根行上，它注册的每个页面都随根行关闭而消失。需要在其他行关闭时仍保留页面的子插件，应作为独立的包发布。

构建出的 `./client` 文件必须是客户端模块系统的 lazy-CJS factory 格式：一段脚本，向页面的模块加载器登记包名和一个 `factory(require)`，见[客户端模块系统的 README](../../packages/client/modules/README.zh.md)。生成它的 `clientBundle` tsdown 预设位于 `packages/client/tsdown.client.ts`，而不在任何已发布的包里，因此仓库之外的包要自己复刻这一步构建。

```jsonc
{
  "exports": {
    ".": { "types": "./lib/types/index.d.ts", "default": "./lib/index.js" },
    "./client": { "types": "./lib/types/client/index.d.ts", "default": "./lib/client.js" }
  },
  "dsh": { "client": { "platform": "web", "inject": ["@deepseek-ai/dsh-client-ui-settings"] } }
}
```

内置命名空间的伴生包就是同样的浏览器半侧放在一个纯客户端包里，宿主 `apply` 为空，列入 Web 组合的插件花名册（[`packages/bundle/web-app/cordis.patch.yml`](../../packages/bundle/web-app/cordis.patch.yml)），并通过 `ctx.settingsScope.whileServed` 注册进 `plugins.item`，页面因此恰好在 Host 服务该命名空间期间存在。
