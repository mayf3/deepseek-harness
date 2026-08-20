# DeepSeek Harness

English | [中文](README.zh.md)

DeepSeek Harness (`dsh`) is an open-source agent harness developed by [DeepSeek AI](https://deepseek.com).

It uses an architecture where **everything is a plugin**, and is powered by [Cordis](https://github.com/cordiverse/cordis), whose design is described in [_A Programming Paradigm for Spatiotemporal Composability_](https://github.com/cordiverse/paper).

## Developer preview

DeepSeek Harness is currently in _developer preview_ and is iterating rapidly. **THERE WILL BE COMPATIBILITY-BREAKING CHANGES.**

## Run

### Run from `npm`

Install `Node.js`, then run:

```sh
npx @deepseek-ai/dsh web
```

The command starts the Web UI at `http://127.0.0.1:3080` by default and opens it in the default browser for a local launch. An SSH launch only prints the host URL because the SSH client or editor owns the local forwarded address. Pass `--no-open` to run the server without opening a browser. See [Web UI guide](docs/user/guide/index.md).

### Run from source

To run from a repository checkout:

```sh
git clone https://github.com/mayf3/deepseek-harness.git
cd deepseek-harness
pnpm install
pnpm run build
pnpm dsh web
```

`pnpm run build` prepares the repository artifacts. `pnpm dsh web` uses those built artifacts without rebuilding.

### Web additions in this fork

The enhanced Session sidebar is part of this fork's source tree, so a source build includes its tag grouping, waiting-state nesting, row menus, archive action, search, and unread-only view. Browser workbench tabs and the whale companion are external Web Profile Bundles; Git does not copy a user's `${DSH_HOME:-$HOME/.dsh}/profiles/web` directory, so each clone must install them once:

```sh
pnpm dsh plugin --profile web add dsh-better-sidebar@latest github:keleus/deepseek-pet
pnpm dsh web
```

Hard-refresh the page after installation. [`dsh-better-sidebar`](https://github.com/omdsh-dev/DSH-better-sidebar) provides the Explorer, editor, terminal, Git, and browser workbench; [`deepseek-pet`](https://github.com/keleus/deepseek-pet) follows the focused Session and agent state, supports dragging, scaling, minimizing, and approval or question interactions, and stores its presentation preferences in that browser.

The maintainer's local Profile also contains the private file dependency `@dsh-user/ui-side-panel`, which adds the task/details panel, pet dock, progress, feeding, and custom background. That package is not stored in this repository and is not installed by the commands above; the public workbench and whale companion work without it.

## Community and support

- Feel free to submit feedback or bug reports through [GitHub Discussions](https://github.com/deepseek-ai/deepseek-harness/discussions).
- Add the [`dsh-plugin`](https://github.com/topics/dsh-plugin) topic to your plugin repository for discoverability.
- Join <a href="https://discord.gg/Ycq5dCaS4">DeepSeek Harness Discord community</a>.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md).

## Development

Start with the [development guide](docs/development.md) and [architecture documentation](docs/architecture.md).

For agents, follow [AGENTS.md](AGENTS.md).

## License

[MIT](LICENSE)

Third-party dependencies and their licenses are disclosed in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
