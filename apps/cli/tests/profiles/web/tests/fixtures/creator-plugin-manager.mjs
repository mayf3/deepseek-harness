/** Test-only IPC assertions over real Creator presets and profile management. */
export const inject = ['agents', 'agentPresets', 'tools', 'pluginManager']

export function apply(ctx, config) {
  const receive = message => {
    if (message !== 'initial' && message !== 'restart') return
    void inspect(message).then(result => process.send({ result }), error => process.send({ error: String(error.stack ?? error) }))
  }
  ctx.effect(() => {
    process.on('message', receive)
    return () => process.off('message', receive)
  })
  async function inspect(phase) {
    const handles = []
    const make = async id => {
      const handle = await ctx.agents.create({ sessionId: id, cwd: process.cwd(),
        setup: scope => ctx.agentPresets.mount(scope, 'cordis').then(() => undefined) })
      handles.push(handle)
      return handle.agent
    }
    const names = agent => ctx.tools.schemas(agent).map(tool => tool.name)
    try {
      const first = await make(`${phase}-first`)
      const before = names(first)
      const result = phase === 'initial'
        ? await ctx.pluginManager.installBundle(config.bundle)
        : ctx.pluginManager.listBundles()
      const second = await make(`${phase}-second`)
      const after = names(first)
      const other = names(second)
      const ping = await ctx.tools.execute({ name: 'mcp__demo__ping', arguments: {}, agent: first,
        callId: `${phase}-ping`, signal: new AbortController().signal })
      const removed = phase === 'restart' ? await ctx.pluginManager.removeBundle('@test/creator-mcp') : undefined
      return { before, result, after, other, ping, removed, remaining: names(first) }
    } finally {
      await Promise.all(handles.map(handle => handle.dispose()))
    }
  }
}
