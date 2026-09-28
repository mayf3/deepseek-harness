# Bundles and Host plugins

A bundle is a package whose `package.json` declares `dsh.bundle.patch`; the YAML patch inserts plugin entries. Give the package and rows unique names; use the Loader's existing YAML syntax, including `!!js` where expressions are needed. Read an existing patch before editing it: a matching override replaces the complete `config`.

## Manifest

A Host-only bundle needs no dependencies, install scripts, or build tool:

```json
{
  "name": "@local/my-plugin",
  "version": "1.0.0",
  "private": true,
  "type": "module",
  "exports": { ".": "./index.js" },
  "dsh": { "bundle": { "patch": "./cordis.patch.yml" } }
}
```

`cordis.patch.yml`:

```yaml
- insert:
    - id: my-plugin
      name: '@local/my-plugin'
      config: {}
```

## Display metadata and icon

Plugin Manager and Settings read `meta.title` and `meta.description` from exported locale JSON without activating plugins. Ordinary plugins read only these resources and use generic artwork. Put the English discovery file at `locale/en.json`; other languages use the same fields:

```json
{ "meta": { "title": "My Decoration", "description": "Draws a badge under the composer." } }
```

Only bundles can customize icons. Keep existing manifest `icon` paths; they take priority. The optional `./icon` export is used only when that field is omitted. Merge resource exports and publication files while retaining runtime exports:

```json
{
  "icon": "./icon.svg",
  "exports": { "./package.json": "./package.json", "./locale/*.json": "./locale/*.json", "./icon": "./fallback-icon.svg" },
  "files": ["locale/*.json", "icon.svg", "fallback-icon.svg"]
}
```

Locale and fallback icon resources support Node exports remapping. No JavaScript `meta` export is needed. A manifest icon stays relative to and inside its declaring manifest directory, including when that manifest is remapped; an exported icon stays inside the real bundle root. Both accept SVG, PNG, JPEG, or WebP up to 256 KiB. Invalid declared icons retain valid text with a diagnostic, without trying the export. An accessible `package.json` also provides optional bundle `name`/`description` fallback; export it if the exports map otherwise hides it. Export-only icons do not require a manifest export. Ordinary plugin display reads never use manifests: missing titles use module names, missing descriptions are omitted, and artwork stays generic.

## Host plugin export forms

`index.js` exports one of these forms; do not mix them:

- `export function apply(ctx, config) {}` with optional `export const inject = ['tools']` and `export const Config`.
- A service class as the default export.

Register every resource inside `apply` with `ctx.effect` or `ctx.on` and return its cleanup. A plugin that declares `Config` validates the row's `config` at activation; query `Config.listConfigs` for an installed plugin's schema before writing its `config`, and follow `$defs` references in the returned document.

## Install, enable, and observe

`plugin_manager` `install_bundle` performs package installation and bundle selection; do not reproduce those steps with shell commands. Only pass `approvedBuilds` after the user explicitly approves the reported pending build scripts. Preserve returned failures and pending states; report success only after observing the requested capability.

`list_plugins` and `list_bundles` return exact identifiers for existing installations. `set_plugin` and `set_bundle` toggle them; `remove_bundle` removes a bundle. Inspect saved-state and activation outcomes separately: `failed` requires diagnosis, `overridden` means a higher-priority layer wins, and `restart-required` means the change is not live. Installing a new bundle can activate through HMR; replacing an installed package requires restart to load a fresh JavaScript module generation. Do not infer updated browser code from an unchanged slot id.
