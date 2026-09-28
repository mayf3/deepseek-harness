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

Only bundles can customize icons. Merge these resource exports and publication files into the bundle manifest, retaining its runtime exports:

```json
{
  "exports": { "./locale/*.json": "./locale/*.json", "./icon": "./icon.svg" },
  "files": ["locale/*.json", "icon.svg"]
}
```

Both resource addresses support Node exports remapping. Do not add a JavaScript `meta` export or a top-level manifest `icon` field. The icon target can be SVG, PNG, JPEG, or WebP up to 256 KiB and must stay inside the real bundle directory, including through symlinks. Icon errors retain valid text. To enable optional bundle `name`/`description` fallback, also export `./package.json`; icons do not require it, and ordinary plugin display reads never use it. Missing ordinary titles use module names, missing descriptions are omitted, and absent or undecodable bundle images use default artwork.

## Host plugin export forms

`index.js` exports one of these forms; do not mix them:

- `export function apply(ctx, config) {}` with optional `export const inject = ['tools']` and `export const Config`.
- A service class as the default export.

Register every resource inside `apply` with `ctx.effect` or `ctx.on` and return its cleanup. A plugin that declares `Config` validates the row's `config` at activation; query `Config.listConfigs` for an installed plugin's schema before writing its `config`, and follow `$defs` references in the returned document.

## Install, enable, and observe

`plugin_manager` `install_bundle` performs package installation and bundle selection; do not reproduce those steps with shell commands. Only pass `approvedBuilds` after the user explicitly approves the reported pending build scripts. Preserve returned failures and pending states; report success only after observing the requested capability.

`list_plugins` and `list_bundles` return exact identifiers for existing installations. `set_plugin` and `set_bundle` toggle them; `remove_bundle` removes a bundle. Inspect saved-state and activation outcomes separately: `failed` requires diagnosis, `overridden` means a higher-priority layer wins, and `restart-required` means the change is not live. Installing a new bundle can activate through HMR; replacing an installed package requires restart to load a fresh JavaScript module generation. Do not infer updated browser code from an unchanged slot id.
