import { clientBundle } from '../tsdown.client.ts'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'

const bundle = clientBundle('@deepseek-ai/dsh-client-ui-chat', ['lib/types/index.js'])
const whaleImage = fileURLToPath(new URL('./src/client/chat/running-whale@2x.png', import.meta.url)).replaceAll('\\', '/')

export default ((options) => bundle(options).map(config => ({
  ...config,
  plugins: [...(config.plugins ?? []), {
    name: 'chat-whale-image',
    resolveId(source: string) {
      return source === './running-whale@2x.png' ? whaleImage : null
    },
    async load(id: string) {
      if (id !== whaleImage) return null
      this.addWatchFile(id)
      const image = await readFile(id)
      return `export default ${JSON.stringify(`data:image/png;base64,${image.toString('base64')}`)}`
    },
  }],
}))) satisfies typeof bundle
