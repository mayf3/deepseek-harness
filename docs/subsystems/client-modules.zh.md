# Client 模块

[English](client-modules.md) | 中文

Web 插件表：[dsh-client-modules](../../packages/client/modules) 中 client 模块系统的 Node 半，以 `ctx.clientModules`（`ClientModuleRegistry`）形式提供。它扫描宿主 Loader 的 entry，找出声明了 `dsh.client` 的包，组合出 `window.__DSH_BOOT__` entry 图，在 `/plugins` 下提供按内容寻址的启动批次与 HMR 独立脚本，并以启动协议行回应每次 index 注入收集——这是同一个服务的四个面。它是 Web GUI 栈的一项可选能力，不属于 agent loop（智能体循环）主干，并且是 [dsh-host-webserver](../../packages/host/webserver) 的消费方：[web-server.md](web-server.zh.md) 所述的载体提供本服务注册的前缀路由与其回应的 `webserver/index-inject` 事件。同一个包的浏览器半（`ctx.modules`，即拉取并物化这些 bundle 的 lazy CJS 模块表）属于内核机件，记录在[包 README](../../packages/client/modules/README.zh.md)中，不在本页。

源码：[`packages/client/modules/src/client/manifest.ts`](../../packages/client/modules/src/client/manifest.ts)

## wire

图是 Node 半与浏览器半之间协议层的唯一真源。宿主从扫描到的包组合出 `WebBootEntry` 行与 `WebBootBatch` 描述，随后在 Vite entry 之前向结构化 index 注入表贡献 registration facade、application preload、bootstrap 脚本与图全局量。`global` 行渲染为 `globalThis["__DSH_BOOT__"]`，其中 `<` 已转义，插件可控的字符串因此无法逃出 script 元素。没有有效 manifest 的页面无法启动：浏览器解析器会拒绝畸形 row 或批次、重复 phase 名、未知成员，以及未恰好归属一个初始批次的 entry。

```ts type-equiv
/**
 * One composed client entry pushed by the host (a graph row). Wire
 * single source: the host node half (package root) produces this same shape.
 * `immediately` marks stage-one prefetch. `inject` names package rows whose
 * factories must arrive before this row materializes, while Cordis separately
 * uses the same package edges to compose entries. `external` carries exact
 * non-inject module requests (see {@link WebBootGraph.entries}).
 */
interface WebBootEntry {
  /** Entry name == package name. */
  id: string
  /** Revisioned individual endpoint used by HMR. */
  url: string
  /** Opaque individual-artifact revision used for HMR cache busting. */
  rev: string
  /** Package-name dependency edges used for factory arrival and plugin composition. */
  inject?: string[]
  /** Stage-one prefetch mark: load the script for factory registration during module-face boot. */
  immediately?: boolean
  /** Non-baseline module specifiers this row requests; omitted when it requests none. */
  external?: string[]
}
```

```ts type-equiv
/** Initial script-delivery phase for one content-addressed bundle batch. */
type WebBootBatchPhase = 'bootstrap' | 'application'
```

```ts type-equiv
/** One initial-load script containing the factory registrations for several graph rows. */
interface WebBootBatch {
  /** Parser-blocking bootstrap or preloaded application delivery. */
  phase: WebBootBatchPhase
  /** Content-addressed batch script endpoint. */
  url: string
  /** Hash over the batch script and indexed source map. */
  rev: string
  /** Graph entry ids whose factories the script registers, in execution order. */
  entries: string[]
}
```

```ts type-equiv
/** The composed client entry graph the host injects as `window.__DSH_BOOT__`. */
interface WebBootGraph {
  /** Consistency anchor over the whole graph (content + bundle hashes). */
  rev: string
  /**
   * Composed entries in module-graph order — a dynamic package row precedes
   * rows whose `external` requests that package. Cordis activation order is
   * unrelated and remains owned by fiber service waiting.
   */
  entries: WebBootEntry[]
  /** Initial-load batches; every entry belongs to exactly one batch. */
  batches: WebBootBatch[]
}
```

每个初始 row 的 `rev` 都是不透明的进程 nonce 加序号，因此组合图时不会哈希每个独立产物。HMR 观察到变化后，该 row 的 revision 才改为新 bundle 及其可用 sourcemap 的哈希。Bootstrap 批次包含 modules row；预加载的 application 批次包含其他全部 row。批次 revision 对生成的脚本与 indexed sourcemap 求哈希，图 revision 则对 row 与批次描述一并求哈希。`immediately` 标记第一阶段的 registration barrier；即使只有部分 application row 携带该标记，它们仍共享一次脚本传输。

## 扫描

包加入这张表的方式，是在自己的 package.json 中声明 `dsh.client`（`platform: 'web'`、可选的 `inject` 边、可选的 `immediately`），并在 `exports["./client"]` 导出构建好的 bundle。包解析锚定在配置树的 `ctx.baseUrl`——即 cordis.yml 所在目录，该目录的包把每个被组合的插件声明为依赖——这一锚点未设置时，构造即抛错。

扫描是单包增量的；不存在全量重扫代码路径。fiber 构造或 dispose（资源释放）时的每次 cordis `internal/plugin` 发射都把该 fiber 的 entry 名标脏，一次微任务 flush 把每个脏名与实时 loader entry 对账。激活趟以全部当前 entry 灌入同一个脏集合并同步 flush，因此初扫与稳态共享一条实现——但失败姿态相反。激活时，已加载 entry 中的畸形声明或缺失 bundle 会聚合为一个大声的 `AggregateError`，列出每个损坏的包：该 fiber 进入 FAILED，由启动的大声失败 sweep 上报。稳态下，损坏的包只记录一条警告，且不得殃及其他包。

包元数据——包括「非 client 包」这一否定结论——按名缓存且永不过期：插件集合的变更在重启后生效。fiber 重启原样复用其行与 rev；bundle 内容变更只经 `rebuilt()` 到达图。

## bundle 路由与 index 注入

`GET`／`HEAD /plugins/_batch/<phase>/<rev>/client.js` 提供生成的启动脚本，并在相邻路径提供 indexed map。`GET`／`HEAD /plugins/<id>/client.js?rev=<rev>` 为 HMR 提供已快照的独立产物，并把同一 revision 写入其 map 请求。所有版本化响应都使用长期 immutable 缓存。未知路径、缺失 map、缺少 revision 及陈旧 revision 都返回 404，绝不在旧 URL 下提供当前字节，也不会让 SPA fallback 把 HTML 当作 JavaScript 返回；其他方法返回 405。注入行在每次 index 渲染时携带当前图，因此重新加载总是基于实时组合启动。

## 服务

```ts type-equiv
/** Filesystem baseline captured before a client artifact snapshot is read. */
interface ClientArtifactBaseline {
  /** Absolute path of the client bundle. */
  readonly path: string
  /** Bundle modification time in milliseconds. */
  readonly mtimeMs: number
  /** Bundle size in bytes. */
  readonly size: number
  /** Source-map modification time, or null when no map was observable. */
  readonly mapMtimeMs: number | null
  /** Source-map size in bytes, or null when no map was observable. */
  readonly mapSize: number | null
}
```

`ClientModuleRegistry`（`ctx.clientModules`，定义于 [`packages/client/modules/src/index.ts`](../../packages/client/modules/src/index.ts)）暴露读取面与重建面；签名见生成的[服务目录](#ctxclientmodules--clientmoduleregistry)。`graph()` 返回当前组合出的图（两次变更之间是同一个稳定对象），`clientPath(id)` 返回 bundle 的绝对路径，`artifactBaseline(id)` 返回读取当前快照前捕获的 bundle/map stat 值。`rebuilt(id)` 是变化后的 bundle 内容到达图的唯一入口：它只对该产物重新哈希，只有 rev 真正变化才会重新组合图并发出通知。`onRebuilt` 按发生变化的 bundle 逐个触发并携带新 rev；`onGraphChanged` 在任何一次重新组合了图的 flush 之后触发（行的增删，或 rebuilt 带来的 rev 变化），并采用拉取模型——监听器自行重读 `graph()`。两条通知路径都会兜住监听器异常，因此一个抛错的订阅者既不能让后续订阅者被跳过，也不能杀死触发这次 flush 的一方。

开发环境下，[dsh-client-hmr](../../packages/client/hmr/README.zh.md) 是注册表的监视驱动：它的 Node 半从 module host 读文件前记录的基线出发，对图中每一行的 bundle 与可选 map 做 stat 轮询，只为变化或标脏的 row 调用 `rebuilt(id)`，经 `onGraphChanged` 重新同步监视集合，并通过 SSE（Server-Sent Events）把 rev 变化广播给浏览器半。生产环境的图完全不含 HMR（热模块替换）行；module host 自身从不监视文件。

<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->

<a id="cordis-surface"></a>

## Cordis API

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — the language sides differ only in locale-specific paired document paths. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.zh.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

<a id="ctxclientmodules--clientmoduleregistry"></a>

### `ctx.clientModules` — `ClientModuleRegistry`

The web plugin table service: incremental `dsh.client` scan + wire composition + bundle route + index injection rows. Construction runs the activation scan synchronously — a malformed declaration or missing bundle among the already-loaded entries aggregates into one loud throw (FAILED fiber; the boot activation audit reports it).

```ts cordis-catalog
/**
 * Current composed entry graph (stable object between changes).
 * @returns the graph served as `window.__DSH_BOOT__`.
 */
graph(): WebBootGraph

/**
 * Absolute path of an entry's client bundle.
 * @param id - entry id (package name).
 * @returns the path, or undefined for an unknown id.
 */
clientPath(id: string): string | undefined

/**
 * Filesystem baseline captured before an entry's current bytes were read.
 * HMR compares it with the live files when installing a watch, so a write
 * between startup composition and watch installation cannot disappear into
 * the watcher's initial state.
 * @param id - entry id (package name).
 * @returns the path and baseline, or undefined for an unknown id.
 */
artifactBaseline(id: string): ClientArtifactBaseline | undefined

/**
 * Re-hash one bundle (the HMR watch's registration hook — the only entry
 * point through which bundle content changes reach the graph).
 * @param id - entry id (package name).
 * @returns the new rev, or undefined for an unknown id.
 */
rebuilt(id: string): string | undefined

/**
 * Subscribe to bundle rebuilds; fires only when the re-hash changed the rev.
 * @param listener - receives the entry id and its new bundle rev.
 * @returns the unsubscriber.
 */
onRebuilt(listener: (id: string, rev: string) => void): () => void

/**
 * Fires after any flush that recomposed the graph (row added/removed, or a
 * rebuilt rev change). Pull model: listeners re-read {@link graph}.
 * @param listener - notified with no payload.
 * @returns the unsubscriber.
 */
onGraphChanged(listener: () => void): () => void
```

Source: [`packages/client/modules/src/index.ts`](../../packages/client/modules/src/index.ts)
<!-- END GENERATED cordis-surface -->
