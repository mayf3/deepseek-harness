/** Private built Node-runtime child entry; source execution calls runNodeMain directly. */
import { openInheritedControlChannel } from '@deepseek-ai/dsh-subprocess/control'
import { runNodeMain } from './process.ts'

await runNodeMain(openInheritedControlChannel(), Number(process.argv[2]), process)
