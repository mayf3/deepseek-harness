# Agent Note：Web @ mention 的发现成本与行内容

Status: implemented

[English](2026-08-27-web-at-mention-discovery-and-row-content.md) | 中文

## Problem

在 Web composer 里 `@` 之后继续输入很慢，而被填满的菜单里塞着并不能区分候选的文字。背后是三个缺陷，一次击键就能全部触达。

会话发现会读取每个持久化会话的完整日志。`listCandidates` 只对空查询先截断到候选上限；非空查询对整个语料调用 `readTitleSnapshots`，而在那里折叠一个标题的代价是完整读一遍该会话的日志。`DEFAULT_PREPARED_SESSION_CACHE_SIZE` 是 5，因此任何真实语料的淘汰速度都快于填充速度，每次击键都重新付冷读的代价。在一个 342 会话的存储上实测：并发 4、页缓存已热的前提下，每次击键 1139 ms 的多帧 zstd 解压与 JSON 解析。这正是用户描述的形状——单独敲 `@` 因为先截断而尚可忍受（约 160 ms），多打一个字符就不行了。

文件索引截断了半个工作区。`WorkspaceFileSearch` 在 `maxEntries` 之下按广度优先填充，因此在第四、五层触顶就会丢弃更深的一切。本仓库有 19 764 个条目而上限是 10 000，其中 8 148 个（41%）是两个默认排除项（`.git`、`node_modules`）覆盖不到的 `lib/` 构建产物。`@AssistantMarkdown` 对一个真实存在的文件返回空；`@MenuView` 返回它的 spec 文件而不是 `MenuView.tsx`。另外，任意 `tool/result` 都会使整个索引失效，因此一个只读工具就会把一次完整遍历挡在下一个光标前面。

行内容自我重复。工作区根目录的文件渲染成 `reference.txt reference.txt`，因为 description 是完整路径而 name 是它的基名。会话行渲染标题、完整 session id、完整 cwd 和一个原始的 `toISOString()` 时间戳。下钻后的目录列表除了删字符没有回退方式，而且其中每一行都写着同一个父目录。

Web e2e 看不到这一切：它的 scaffold 固定使用只含两个会话的隔离 `DSH_HOME`。

## Decision

**发现成本取决于投影缓存的覆盖率。** `SessionReferenceResolver` 用 `ctx.sessionProjectionCache.cachedSnapshot(header, ['title'])` 标注候选，这是一次同步内存读，`api-session.list` 已经在用。缓存已建立 checkpoint 的会话完全不需要读日志。其余会话各折叠一次并按进程生命周期记在 resolver 上，以该 header 的创建事实为键，因此被复用的 id 不会继承过期标题；重新挂载的会话永不被记住，因为它的日志仍在增长。非空查询在过滤之前折叠尚未 checkpoint 的剩余部分，因为过滤读取的正是标签——把这次折叠推迟到截断后的页面，会让一个会话按它自己的标题搜不到。空查询不做过滤，因此它未解析的尾部留给页面处理。

缓存是可选的；未组合缓存时，先前的折叠路径原样保留，包括「未经过滤的列表只折叠按 cwd 排序的头部」这一限制。

**失效的文件索引在替代品构建期间继续作答。** `invalidate()` 递增一个计数器而不是丢弃遍历。裸查询由已完成的条目作答，并启动一次后台重建、完成后原子替换；只有一个工作区的首次裸查询会等待。失败的刷新保留陈旧条目与计数器，下一次查询因此重试。`DEFAULT_FILE_SEARCH_EXCLUDED_DIRECTORIES` 从两个名字增至十六个——版本控制与依赖目录，加上本 harness 运行的各生态的构建产物基名——`DEFAULT_FILE_SEARCH_MAX_ENTRIES` 提高到 50 000。两者仍是部署方可覆盖的 `excludedDirectories` 与 `maxEntries` 配置字段。

**每一行只承载能区分它的信息。** 文件显示其父目录，位于工作区根目录时不显示。下钻后的目录列表不显示父目录，因为面包屑已经在显示。会话仅在 `SessionReferenceCandidate.sameWorkspace` 为 false 时显示其工作区——由宿主计算，因为排序时它本就同时握有两个工作目录——并使用会话列表所用的相对时间分档标注时间，因此同一个会话在两处读到的时长一致。`relativeTime` 从 `ui-workspace` 的 `tree.ts` 移到 `ui-primitives`；按 locale-owned 文案的规则，词句仍留在各插件自己的字典里。session id 离开行内：它本就是无标题会话回落到的标签。

**下钻会发布面包屑，键入路径不会。** `InputTriggerSource` 增加可选的同步 `header(session, req)` 钩子返回面包屑，在每次命中时以实时查询与管线持有的 `drilled` 标记重新询问，后者说明该查询由下钻还是键入产生。`CandidateRequest` 携带同一个标记。面包屑走菜单 store 之外的独立快照 store，冻结的菜单归约器因此对它一无所知；点击面包屑经 `onPick` 以 `action: 'drill'` 路由——「回到某一步」与「进入某一层」是同一个结果。`MenuView` 把头部渲染在其滚动视口之上，并把 `role="listbox"` 移到该视口上，因为面包屑不是选项，listbox 也不得承载它。

中文 composer placeholder 改为 `文件或对话`，与同一个菜单已经显示的 `对话` 分组标题一致。

## Alternatives considered

**彻底信任投影缓存：没有缓存行就没有标题。** 先被实测否决，再被测试否决。真实存储里 342 个会话只有 154 个带缓存记录，其中 111 个带标题；其余早于缓存存在或从未 checkpoint。Web e2e 当场抓到——一个被 seed 的冷会话按它自己日志里的标题搜不到了。

**只为截断后的页面折叠未 checkpoint 的标题。** 否决：过滤发生在页面存在之前，因此按标题子串查询恰好会跳过那些被推迟折叠的会话。仅页面折叠这一形态保留给空查询路径，那里不做过滤。

**给候选拉取加防抖。** 否决。归约器在每次命中时已经把所有分组重置为 pending，因此尾部防抖会延长骨架状态，输入时读起来更慢。折叠成本移除后，往返时间不再值得一个定时器；在新 generation 下保留上一批行是另一个决定，带有误选后果，此处不做。

**读 `.gitignore` 来约束索引。** 暂时否决：这会给一条必须保持同步且廉价的路径引入 ignore 文件解析器与 git 依赖。基名列表覆盖了实测的 41%，且本就是配置字段。把源码放在其中某个基名下的工作区需覆盖 `excludedDirectories`。

**让 `MenuView` 识别 `@` 触发符并自行绘制面包屑。** 否决：`MenuView` 与 `/` 共用，把文件引用语义硬编码进去，越过了 source 注册表本就用来守住的包边界。

**把 `drilled` 作为可选字段加进 `CandidateRequest`。** 否决：管线始终知道它，而可选字段会诱使 source 把「请求早于该字段」读成「未下钻」。改为必填并更新每一处调用点，符合预发布阶段的取舍。

## Consequences

未组合 `session-projection-cache` 的部署保持原有成本与原有的仅头部折叠。组合之后，对缓存尚未覆盖的语料，首次查询仍会读一次那些日志；记忆化把它变成按日志一次而不是按击键一次的成本。专用标题索引可以消除剩余部分，session-reference README 现在把它记为开放路径。

文件索引落后一次失效：紧接工具结果之后的裸查询反映的是上一次遍历时的目录树，下一次查询才看到重建结果。把源码放在被排除基名下的工作区需要覆盖 `excludedDirectories`。

`aria` golden 的形状改变：listbox 角色现在落在内层元素上，且行内携带会随套件运行而推进的相对时间分档。`normalizeAria` 在 duration 规则之前把该词汇归一为 `{{age}}`，锚定在 aria 标签的右引号上。

引用行的内容现在派生自相邻 chrome 已经显示的信息——下钻列表的面包屑、会话的当前工作区。未来若有不带这些 chrome 的界面渲染同一批候选，它显示的信息会不足，必须向 source 索取另一种投影，而不是自行重新推导路径。

## Testing

包级测试覆盖 checkpoint 路径（一次不读任何日志的过滤查询）、记忆化冷折叠及其身份失效、保证标题过滤完整的未 checkpoint 尾部折叠、含刷新失败在内的 stale-while-revalidate，以及面包屑契约的两端。`reference-composer.e2e.ts` 覆盖随附组合：刷新后的菜单 golden 显示精简后的行，新增用例下钻进入文件夹、断言面包屑只在此时出现、并点击根节点回到裸 `@`。

1139 ms 是针对真实存储的服务端 I/O 实测下限，不是插桩得到的端到端 UI 延迟；web e2e scaffold 的隔离 `DSH_HOME` 无法复现产生该数字的语料。
