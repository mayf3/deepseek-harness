import { describe, expect, it } from 'vitest'
import { CODE_HIGHLIGHT_EXTENSIONS, languageForPath } from '../src/index.ts'

describe('languageForPath', () => {
  it.each([
    // Windows-facing script and shell extensions.
    ['build.bat', 'bat'], ['build.cmd', 'bat'], ['deploy.ps1', 'powershell'],
    ['module.psm1', 'powershell'], ['data.psd1', 'powershell'], ['config.fish', 'fish'],
    // Config, data, and text extensions.
    ['app.properties', 'ini'], ['app.conf', 'ini'], ['app.cfg', 'ini'],
    ['.env', 'dotenv'], ['server.log', 'log'], ['rows.csv', 'csv'],
    ['change.diff', 'diff'], ['fix.patch', 'diff'], ['api.http', 'http'],
    ['notebook.ipynb', 'json'],
    // Documentation and markup extensions.
    ['guide.rst', 'rst'], ['paper.tex', 'latex'], ['style.sty', 'latex'],
    ['doc.cls', 'latex'], ['refs.bib', 'bibtex'], ['Info.plist', 'xml'],
    ['logo.svg', 'xml'], ['manual.adoc', 'asciidoc'],
    // Language extensions.
    ['analysis.r', 'r'], ['model.jl', 'julia'], ['main.dart', 'dart'],
    ['Main.scala', 'scala'], ['core.clj', 'clojure'], ['ui.cljs', 'clojure'],
    ['data.edn', 'clojure'], ['app.erl', 'erlang'], ['app.hrl', 'erlang'],
    ['app.ex', 'elixir'], ['app.exs', 'elixir'], ['Main.hs', 'haskell'],
    ['Types.fs', 'fsharp'], ['Types.fsi', 'fsharp'], ['script.fsx', 'fsharp'],
    ['Form.vb', 'vb'], ['script.pl', 'perl'], ['Module.pm', 'perl'],
    ['top.v', 'verilog'], ['top.sv', 'system-verilog'], ['defs.svh', 'system-verilog'],
    ['schema.graphql', 'graphql'], ['query.gql', 'graphql'], ['message.proto', 'proto'],
    ['main.tf', 'hcl'], ['terraform.tfvars', 'hcl'], ['stack.hcl', 'hcl'],
    ['flake.nix', 'nix'], ['App.vue', 'vue'], ['App.svelte', 'svelte'],
    ['Makefile', undefined], ['build.mk', 'make'], ['CMakeLists.cmake', 'cmake'],
    ['build.gradle', 'groovy'],
  ])('resolves %s to %s', (path, language) => {
    expect(languageForPath(path)).toBe(language)
  })

  it('keeps the extensions the two former tables already agreed on', () => {
    expect(languageForPath('src/a.ts')).toBe('typescript')
    expect(languageForPath('src/a.TSX')).toBe('typescript')
    expect(languageForPath('/abs/module.mjs')).toBe('javascript')
    expect(languageForPath('conf.yml')).toBe('yaml')
    expect(languageForPath('README.md')).toBe('markdown')
    expect(languageForPath('C:\\src\\main.rs')).toBe('rust')
  })

  it('resolves every extension that only the preview table knew, including the new ones', () => {
    for (const extension of ['jsonl', 'ndjson', 'pyw', 'pyi', 'rake', 'gemspec', 'hh', 'hxx', 'kts', 'xhtml', 'xsd', 'xsl', 'xslt']) {
      expect(languageForPath(`file.${extension}`), extension).toBeDefined()
    }
  })

  it('is case-insensitive and accepts Windows separators', () => {
    expect(languageForPath('C:\\path\\X.PS1')).toBe('powershell')
    expect(languageForPath('C:\\Proj\\Build.CMD')).toBe('bat')
    expect(languageForPath('dir\\sub\\Main.SCALA')).toBe('scala')
  })

  it('reads the suffix after the last path segment and last dot', () => {
    expect(languageForPath('a.py.bak')).toBeUndefined()
    expect(languageForPath('archive.tar.gz')).toBeUndefined()
    expect(languageForPath('/dir.py/plain')).toBeUndefined()
    expect(languageForPath('dir.ts/README')).toBeUndefined()
  })

  it('returns undefined for a dotfile, an extensionless name, a trailing dot, and an unknown suffix', () => {
    expect(languageForPath('.gitignore')).toBeUndefined()
    expect(languageForPath('/etc/hosts')).toBeUndefined()
    expect(languageForPath('trailingdot.')).toBeUndefined()
    expect(languageForPath('data.unknownext')).toBeUndefined()
  })

  it('returns undefined for a filename whose extension is an Object.prototype key', () => {
    expect(languageForPath('foo.constructor')).toBeUndefined()
    expect(languageForPath('foo.__proto__')).toBeUndefined()
    expect(languageForPath('foo.toString')).toBeUndefined()
    expect(languageForPath('foo.hasOwnProperty')).toBeUndefined()
  })

  it('leaves certificate and lock extensions unlisted', () => {
    for (const extension of ['pem', 'crt', 'key', 'cer', 'lock']) {
      expect(languageForPath(`secret.${extension}`), extension).toBeUndefined()
    }
  })
})

describe('CODE_HIGHLIGHT_EXTENSIONS', () => {
  it('lists every recognized suffix exactly once', () => {
    expect(new Set(CODE_HIGHLIGHT_EXTENSIONS).size).toBe(CODE_HIGHLIGHT_EXTENSIONS.length)
    expect(CODE_HIGHLIGHT_EXTENSIONS.length).toBeGreaterThan(100)
  })

  it('resolves each listed suffix back to a language', () => {
    for (const extension of CODE_HIGHLIGHT_EXTENSIONS) {
      expect(languageForPath(`file.${extension}`), extension).toBeDefined()
    }
  })
})
