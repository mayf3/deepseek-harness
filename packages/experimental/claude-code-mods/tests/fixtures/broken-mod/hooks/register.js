export function register(on) {
  on('tool.calls', async ($, e, next) => next(e))
}
