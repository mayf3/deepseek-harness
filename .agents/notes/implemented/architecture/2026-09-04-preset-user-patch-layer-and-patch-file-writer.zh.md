# Agent Note：preset 获得用户补丁层，补丁文件有了唯一的家

Status: implemented

[English](2026-09-04-preset-user-patch-layer-and-patch-file-writer.md) | 中文

## 问题

随附的 agent preset 在任何意义上都是只读的：想关掉它的一行或给它加一个工具，只能整个复制 preset 再改副本，而副本从此在每次升级时与随附版本渐行渐远。profile 早已具备解决这件事的形状——一份基底组合加一层施加其上的 `cordis.patch.yml` 用户层——而 preset 没有任何对应物。另一方面，这种文件格式在 `dsh-app-boot` 里只有一个解析器而没有写入器：想关掉一行的程序只能整个改写文件，丢掉作者的注释和它看不懂的 `!!js` 门。

## 决定

**preset 的用户层就是其槽位里的 `cordis.patch.yml`。** 本地创作的 preset 放在组合旁边；随附 preset 则单独放在用户根目录里同 id 的目录（`$DSH_HOME/.agent-presets/<id>/cordis.patch.yml`），其安装目录不动。discovery 把这一层挂到赢得该 id 的 preset 上，与组合一起判定健康（不可解析的层、畸形的 insert、或插入了无法解析模块的行，都以该原因让 preset 变为 broken），并把没有任何根提供其 id 的层报告为损坏的槽位而不是藏起来。mount 把解析后的层作为 include 的运行时 patches 交上去，于是它以 Loader 自己的补丁语义施加。组合清单在展平前先施加它，并给每一行标上 `source: 'preset' | 'user'`，关闭时再标上 `disabledBy: 'composition' | 'user'`。复制会把该层带到新组合旁边；`removeOverlay` 删除它以及被清空的槽位。

**代际跟随层的内容。** 常驻挂载的印记现在覆盖组合文件的 stat 与层文本的摘要。层变化即为之后创建的会话开启下一代，一如组合被编辑时的既有行为；层被改回某个早先代际组合过的内容时，回到那一代，因此一行关掉再打开不会堆出第三棵在线子树。

**`dsh-patch-file` 拥有这种格式。** `parsePatchList` 从 `dsh-app-boot` 搬出，成为唯一的解析器（js-yaml 配 include 的 `!!js` 方言，相对名字锚定到文件）；`PatchDocument` 通过 `yaml` 包保留注释的 document 在键级编辑文件，它把未解析的 `!!js` 标签留在标量上并原样打印；`mutatePatchFile` 拿 `dsh-atomic-write` 的锁，读取、编辑、在 document 变脏时原子替换，并把写出的文本回读解析。被移除行上方的注释块移到邻居或文档尾注释，而不是消失。

**`dsh-global-tool-mask` 是写成行的 `tools.restrict()`。** preset 的层能加行却减不掉宿主工具；这一仅限作用域的行对某个 preset 的会话遮蔽点名的全局工具，并拒绝无作用域挂载、空掩码与宿主未注册的名字。

## 考虑过的替代方案

**为每个 preset 用一个 settings 命名空间做启停。** 在设计阶段已否决：启停是组合而非偏好，profile 自己的用户层本就是补丁文件；preset 的应当是同样格式的同一种文件。

**原地编辑随附组合。** 否决：升级会覆盖它，而正在运行的会话会读到写了一半的文件。

**在 `dsh-agent-presets` 里再写一个解析器以避免依赖 `dsh-app-boot`。** 否决：同一格式的两个解析器会漂移；改为让格式拥有自己的包，两者都依赖它。

## 后果

一个人用 `.agent-presets/standard/` 下的三行就能对 `standard` 隐藏一个工具并保留随附组合；插件管理器替他们写同一个文件。层作用于其变化之后创建的会话，从不作用于运行中的会话。层按组合自己的 id 寻址行，因此组合留作匿名的行无法被定位。

## 测试

`packages/preset/agent-presets/tests/overlay.spec.ts` 钉住 discovery（附着、自有层、孤儿槽位、不可解析、畸形、不可解析的插入、组合判定优先）、施加层的挂载、编辑之间的代际及退役代际的复用、清单从文件与从挂载得到的 `source` 与 `disabledBy`、随附与自作 preset 的层路径、复制携带层，以及移除。`packages/util/patch-file/tests/patch-file.spec.ts` 钉住解析器、保留注释与 `!!js` 的文档编辑，以及带回读的加锁原子变更。`packages/preset/global-tool-mask/tests/global-tool-mask.spec.ts` 钉住该行的作用域与拒绝。
