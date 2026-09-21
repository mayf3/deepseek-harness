# Cookbook: adding a settings page

English | [中文](adding-a-settings-card.zh.md)

How a plugin puts its own configuration on the web client's Plugins page, and how it contributes to another plugin's page there. Nothing in this path needs a change inside this repository: the Host serves every registered settings namespace, and the Plugins page declares the slots a page or a contribution registers into.

The two halves of a community bundle live in one package — the Host half under `src/`, the browser half under `src/client/`, exported as `./client` and declared with `dsh.client`. A built-in plugin whose package cannot carry a browser half ships its page as a companion client package instead; [`packages/client/ui-settings-shell`](../../packages/client/ui-settings-shell) is the template.

## 1. Register the namespace (Host half)

The namespace is the join key, so pick it once and spell it in both halves. A consumer that already has a `cordis.yml` entry should register through `ctx.settings.installSection()`, which layers the entry under the user document and keeps working when no settings provider is mounted:

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

`role('secret')` on a field keeps its value off every response; the page writes such a field through the `credentials` domain instead. `applies: 'restart'` tells a configuration surface the owner acts on a change only at the next start.

## 2. Register the page (browser half)

The page registers into one of the Plugins page's configuration slots and owns everything inside it — controls, copy, and styles. A bundle's own configuration goes into `plugins.bundle.config`, keyed by the package name; the configuration of one row the bundle declares goes into `plugins.row.config`, keyed by `<package name>#<row id>`, which gives that row a configure control opening the row's page. The page asks every entry for two views: `summary` for the one-liner under the title, `page` for the form.

The form reads and writes through `ctx.settingsScope`, which fences each write with the revision it read. The `ui-primitives` kit carries the staged-edit model and the controls, so a page declares its fields and renders them:

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

`MyPluginPage` renders `t('summary')` for `view === 'summary'` and, for `page`, a `SettingsForm` around `SettingsValueField` controls, passing the frame its copy as `labels`. A field's presence in the raw user layer — not its value — is what marks it overridden; a reset clears that field so it re-inherits the composition layer. Only a save writes, and leaving the page drops every draft.

## 3. Contribute to another plugin's page

A plugin with something to say about a bundle, a row, or an official plugin it does not own registers into `plugins.detail.actions` (a control at the head of the page), `plugins.detail.badge` (a tag beside the title), or `plugins.detail.section` (a section under the page's own content). Every entry is rendered with the page's `subject` — `{ kind: 'bundle', pkg }`, `{ kind: 'row', pkg, row }`, or `{ kind: 'item', id }` — and returns null for a subject it has nothing for:

```tsx ignore-check
ctx.slots.inject('plugins.detail.badge', () => ctx.slots.register({
  name: 'plugins.detail.badge',
  id: 'acme-update',
  locale: 'acmeUpdate',
}, ({ t, subject }) => subject.kind === 'bundle' && hasUpdate(subject.pkg) ? <Tag tone="info">{t('update')}</Tag> : null))
```

## 4. Where the browser half rides

The browser half is served to the page by the [client module system](../../packages/client/modules), which scans the enabled Loader entries for packages declaring `dsh.client` and serves each one's built `./client` export — but it attaches a package's half to the Loader row whose specifier is the bare package name. A row mounted from a subpath export never carries a half, so a bundle that splits one package into several rows keeps its half on the root row, and every page it registers goes away when that row is switched off. A sub-plugin whose page must outlive the other rows ships as its own package.

The built `./client` file must be in the client module system's lazy-CJS factory format: one script that registers the package name and a `factory(require)` with the page's module loader, described in the [client module system's README](../../packages/client/modules/README.md). The `clientBundle` tsdown preset that emits it lives in `packages/client/tsdown.client.ts` rather than in a published package, so a package outside this repository reproduces that build itself.

```jsonc
{
  "exports": {
    ".": { "types": "./lib/types/index.d.ts", "default": "./lib/index.js" },
    "./client": { "types": "./lib/types/client/index.d.ts", "default": "./lib/client.js" }
  },
  "dsh": { "client": { "platform": "web", "inject": ["@deepseek-ai/dsh-client-ui-settings"] } }
}
```

A companion package for a built-in namespace is the same browser half in a client-only package with an empty Host `apply`, listed in the web composition's plugin roster ([`packages/bundle/web-app/cordis.patch.yml`](../../packages/bundle/web-app/cordis.patch.yml)) and registering into `plugins.item` through `ctx.settingsScope.whileServed`, so the page exists exactly while the Host serves the namespace.
