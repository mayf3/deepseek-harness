# Agent Note: Inspector execution realms and protocol planes

Status: proposed

English | [中文](2026-08-26-inspector-execution-realms-and-protocol-planes.zh.md)

## Problem

The Inspector package executes code in three JavaScript environments: the browser Client, the Host Node main thread, and an Inspector Worker thread. Its current source tree mixes execution ownership with feature names: browser and Host producers have unrelated layouts, Worker-executed Client and Host backends sit under a generic backend directory, and one protocol directory combines transport frames, Cordis data, network observations, and CDP-oriented Runtime values. A file path therefore does not establish where code runs or which identifiers it may own.

This ambiguity is risky because Host and Client support intentionally differs while their architecture must remain comparable. Host Runtime and Debugger delegate to Node's inspector protocol; Client Runtime and Console simulate the same backend semantics over an internal bridge. If their files, interfaces, and unsupported operations diverge structurally, each new protocol method encourages a second routing model. Likewise, consumers that only need the Cordis runtime tree must not inherit debugger activation, Chrome connection state, or CDP identifiers.

The [cross-realm CDP inspector decision](../../implemented/architecture/2026-08-23-cross-realm-cdp-inspector.md) continues to own Worker, transport, Runtime, debugger, and security behavior. The [Cordis runtime tree inspection decision](../../implemented/architecture/2026-08-24-cordis-runtime-tree-inspection.md) continues to own Cordis tree semantics, object routing, and DOM projection. This proposal owns source placement, dependency direction, and the separation between domain data, backend semantics, internal transport, and Chrome CDP state.

## Proposal

Top-level source directories will identify execution ownership. `client/` will contain only browser Client code, `host/` only Host Node-main-thread code, `worker/` only Worker-thread code, and `shared/` code that is safe in every environment. A module that executes in the Worker on behalf of a Client still belongs under `worker/`, not `client/`.

The repository-required `src/index.ts` and `src/invariant.ts` discovery entries are the only root-level source exceptions. They expose the Host package entry and its service type or register the invariant companion, contain no Inspector runtime implementation, and remain at fixed paths for repository tooling.

```text
src/
  shared/   environment-independent data and interfaces
  client/   browser Client producer and adapters
  host/     Host Node-main-thread producer and adapters
  worker/   Worker transport, repositories, realm backends, and CDP endpoint
```

`client/` and `host/` will have the same relative directories and filenames. Their common roles are plugin entry, bridge lifecycle and RPC, Cordis and network inspection, and CDP-oriented Runtime, Console, Debugger, Sources, Profiler, and HeapProfiler adapters. Support may differ: an unavailable operation remains in the corresponding mirrored module and returns the shared capability-unavailable or typed-unsupported result. Mirroring standardizes where a capability is implemented; it does not claim equal engine support.

Worker-side realm adapters will use the same rule under `worker/realms/client/` and `worker/realms/host/`. These adapters normalize Client simulation and Node inspector behavior behind shared CDP-oriented backend interfaces. They do not own Chrome wire messages or connection-local CDP identifiers.

## Execution ownership

`client/` owns page-realm observation, Client object handles, browser evaluation, browser Console interception, Client source publication, and its direct authenticated bridge to the Worker. It may use browser APIs but not Node or Worker implementation modules.

`host/` owns Cordis plugin composition on the Node main thread, Worker startup and disposal, Host object observation, fetch capture, Node inspector notification forwarding, and the Host side of the Worker bridge. It may use Node APIs but does not construct Chrome CDP responses.

`worker/bridge/` owns source admission, transport endpoints, connection generations, frame dispatch, correlation, and routing between source producers and Worker consumers. `worker/inspection/` owns retained Cordis and network observations plus transport-independent queries. `worker/realms/` owns the normalized Host and Client runtime backends. `worker/cdp/` owns HTTP discovery, DevTools sessions, Chrome method dispatch, domain enable state, and every connection-local Chrome identifier.

The Worker remains the sole Chrome CDP wire and state owner. Client code simulates shared backend operations, not the CDP wire. Host code delegates supported backend operations to Node inspector, but Node protocol identifiers are translated inside the Worker Host realm before common domain projection.

## Data and identifier ownership

`shared/cordis/` contains the CDP-independent semantic model, immutable snapshots, collection and observation, realm-local object registration, projections, and reader interfaces. `model.ts` contains no transport handles or CDP identifiers. `snapshot.ts` may carry a realm-local opaque object reference because a live object query needs that route, but consumers can project it away.

`shared/network/` contains fetch and network observations, captured body representation, and header normalization. These records describe observed activity and do not contain CDP request ids or domain enable state.

`shared/cdp/` contains normalized backend interfaces and values for realm capabilities, Runtime, Console, Debugger, Sources, Profiler, HeapProfiler, and typed unsupported results. Backend handles in these interfaces are opaque and realm-owned. They are not Chrome `RemoteObjectId`, `ExecutionContextId`, `ScriptId`, or `CallFrameId` values.

`shared/bridge/` contains the versioned internal carrier: source and generation identifiers, envelopes, codecs, validation, bounded publication, RPC correlation, dispatch interfaces, and domain-specific message unions. Its message modules may transport Cordis snapshots, network observations, Console events, Runtime operations, source reads, debugger operations, and semantic queries without turning those values into CDP messages.

`worker/cdp/ids.ts` is the only owner of Chrome connection-local identifiers such as `RemoteObjectId`, `ExecutionContextId`, `ScriptId`, `NodeId`, and `CallFrameId`. Worker domain sessions allocate and release them and map them to realm backend handles or inspection records. Source, generation, sequence, request, Cordis Fiber uid, realm object reference, backend handle, and Chrome id remain distinct types because their owners and lifetimes differ.

## Dependency rules

The domain modules `shared/cordis/`, `shared/network/`, and `shared/cdp/` do not import `shared/bridge/` or any execution-specific directory. `shared/bridge/` may import those domain types when defining internal messages. No module under `shared/` imports Node-only or browser-only APIs.

Top-level `client/` and `host/` import `shared/` but never each other or `worker/`. Equivalent roles use equivalent shared interfaces. Environment-specific transport and engine behavior stays in the mirrored implementation file rather than entering a shared conditional implementation.

`worker/realms/` and `worker/inspection/` import shared interfaces but do not import `worker/cdp/`; normalized backend results and stored observations cannot contain Chrome connection state. `worker/cdp/` may consume realm and inspection interfaces to project CDP. `worker/bridge/` routes shared messages and invokes Worker services without becoming an owner of Cordis, network, Runtime, or Chrome state.

The package remains one `@deepseek-ai/dsh-experimental-inspector` package with explicit Client and Host compiler faces. Directory separation is an execution and dependency rule, not a package split.

## Migration order

First, the current Cordis implementation and its semantic types move into `shared/cordis/`. The current protocol directory then separates into `shared/bridge/`, `shared/cdp/`, and `shared/network/` while preserving validated frame discriminants and limits.

Next, top-level Client and Host files move into exact mirrored paths. Missing support is represented explicitly so the mirrors remain complete. Worker Client and Node backends then move to mirrored `worker/realms/client/` and `worker/realms/host/` directories, with Node renamed to Host at the architectural interface.

Finally, source transport and routing move under `worker/bridge/`, Cordis, network, and query repositories under `worker/inspection/`, and Chrome endpoint and domains under `worker/cdp/`. Imports, explicit compiler-face file lists, package entries, and focused tests change with each owning layer. The final tree has no generic top-level `protocol/` or `cordis/` directory and no generic `worker/backends/` directory.

## Alternatives considered

**Organize every file by feature domain.** Rejected because a Runtime or Cordis feature spans three environments with different available APIs. Feature-only paths conceal execution constraints and make accidental browser-to-Node imports difficult to review.

**Put Worker Client and Host adapters in top-level `client/` and `host/`.** Rejected because those adapters execute in the Worker and own different resources from page and Node-main-thread producers. A directory name must answer where code runs before it answers which remote realm it represents.

**Allow Client and Host trees to contain only currently supported files.** Rejected because asymmetric layout obscures missing capability decisions and lets equivalent routing roles acquire unrelated interfaces. Explicit unsupported implementations keep evolution exhaustive without pretending support exists.

**Keep one shared protocol directory.** Rejected because internal carrier identities, Cordis semantic data, normalized Runtime values, and Chrome wire identifiers have different consumers and lifetimes. A single directory encourages domain models to depend on transport and CDP presentation.

**Split Client, Host, protocol, and Worker into separate packages.** Rejected for the experimental phase. The deployment unit remains one Client/Host Cordis plugin, and package boundaries would add build and release coordination without improving the required execution separation.

## Acceptance criteria

- Every runtime implementation has an unambiguous execution owner through `shared/`, `client/`, `host/`, or `worker/`; only the repository-required package and invariant forwarding entries remain at the source root.
- Top-level Client and Host trees, and Worker Client and Host realm trees, have identical relative implementation paths; unequal capability support is explicit and typed.
- Cordis and network readers can be used without importing debugger, source, transport, or CDP session modules.
- Internal messages contain source-level identities and validated domain values but no Chrome connection-local ids.
- Normalized realm backend interfaces support Host delegation and Client simulation without either implementation constructing Chrome CDP messages.
- Only Worker CDP modules allocate Chrome ids and own DevTools connection enable, object, script, node, and call-frame state.
- Existing Host Runtime and debugging, Client Runtime and Console, Network capture, Cordis Elements projection, disconnect retention, and semantic query behavior remain covered after the move.
- Compiler faces, import checks, and a structural test reject environment leaks and Client/Host mirror drift.

## Risks

Exact mirroring adds small adapter files for unsupported capabilities. Those files are intentional compatibility points between implementations, but they must stay thin and must not manufacture fake behavior.

Moving types without changing behavior can still expose hidden dependency cycles, especially where Runtime object annotation reaches Cordis repositories. The dependency rules require inversion through shared interfaces rather than a temporary import from a lower-level module.

`shared/cdp/` can become a second copy of the Chrome protocol if normalized types are added indiscriminately. A shared type belongs there only when both realm implementations or a common Worker projector consume it; Chrome session bookkeeping and wire-only fields remain under `worker/cdp/`.

The migration may temporarily leave the package uncompilable between local move steps. The completed change must restore both compiler faces and behavior tests before review.
