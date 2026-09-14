# Agent Note: Profile patch 文件共用一个解析器与写入器

Status: implemented

[English](2026-09-04-profile-patch-file-writer.md) | 中文

## Problem

启动器与插件管理器消费相同的 profile patch 格式。独立解析器可能对可接受的行或相对模块路径得出不同结果，而将 YAML 文档转成普通对象重写会丢失注释和未求值的 `!!js` 表达式。

## Decision

`dsh-app-boot/patch-file` 负责 patch 解析与编辑。启动入口委托它解析；管理操作使用它保留注释的 YAML 文档和持锁的原子写入器。相对插件名以 patch 文件所在目录解析。编辑行时保留无关字段、注释与表达式文本；删除行时将其注释保留到相邻行或文档上。

## Alternatives considered

**独立解析器或整份文档序列化。** 两者都可能让一个消费方接受的文件在另一个消费方中改变含义。共享解析器定义可接受的输入，YAML 文档编辑器则保留普通对象序列化会丢弃的语法。

## Consequences

全局行操作编辑 profile 用户层，不修改组合包文件。一次写入在读取、修改和原子替换期间持有文件锁，然后解析写入结果。未改变的文档不会重写。

## Testing

`packages/boot/app-boot/tests/patch-file.spec.ts` 覆盖解析、相对模块路径、注释、`!!js`、行编辑、锁和写入失败。插件管理器测试通过真实 profile 文件验证全局行修改。
