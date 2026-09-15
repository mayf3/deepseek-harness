# Agent Note: 侧栏工作区层级

Status: implemented

[English](2026-09-15-sidebar-parent-folders.md) | 中文

## 问题

许多目录共享同一父目录时，平铺的 Workspace 列表不便浏览相关项目。若让父目录拥有所有后代 Session，则会违背 Workspace 成员 Session 的规范工作目录必须等于注册路径这一要求。

## 决策

侧栏从已注册的 Workspace 路径派生递归层级。每个 Workspace 位于最近的严格祖先下；相同路径不会成为自己的父级。比较遵循目录分隔符和 Host 的大小写拼写，不解析符号链接别名。同级项目保留 Host 顺序。

添加目录会直接注册普通 Workspace 并打开其 Session。父 Workspace 保留自己的 Session 和标准行操作。现有的浏览器本地展开状态同时控制子 Workspace 和父级自己的 Session 行；没有显式偏好时，祖先默认展开。所有行的高亮与点击区域等宽，内容按层级缩进。Workspace 拖拽限制在同级之间，搜索导航会展开全部祖先。

## 考虑过的替代方案

**递归 Workspace 成员关系：**这会改变工作目录不变量，并让一个 Session 同时符合多个记账。展示嵌套不需要这两项改变。

**独立父目录记录与添加时选择：**这会重复表示已有 Workspace 目录，并为普通添加增加确认。根据注册表派生层级可保留单一添加流程，并让每个目录都能拥有 Session。

**自动发现目录：**这能展示尚未注册的项目，但需要文件系统列举、刷新和采用行为。侧栏仅使用当前 Workspace 列表。

## 结果

用户可以折叠相关项目，而不改变 Session 归属。删除祖先会保留子工作区注册；独立的 [Workspace 删除语义](2026-07-27-workspace-registration-deletion.zh.md)仍决定被删除 Workspace 自身 Session 的处理，该决策继续有效。浏览器本地折叠偏好不跨浏览器同步，嵌套取决于规范路径拼写。

纯路径测试覆盖严格祖先关系、路径段边界、POSIX 反斜杠和 Windows 分隔符。组件与浏览器场景覆盖直接添加、后续注册、父级独立 Session、折叠恢复、搜索展开、同级排序及整行等宽。
