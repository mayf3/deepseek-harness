// @vitest-environment jsdom
/**
 * SPIKE (Phase 0): validates the jsdom driving model for the Lexical composer
 * before the real implementation lands. Answers three questions: (1) can a
 * shell-owned headful editor render into jsdom and accept update-driven
 * edits; (2) can synthetic beforeinput/keyboard events drive Lexical in
 * jsdom, or must component tests drive through the command layer; (3) do
 * DecoratorNode portals render and keep DOM identity when text is inserted
 * before them. Deleted/absorbed into the real suites at the end of Phase 4.
 */
import { describe, expect, it } from 'vitest'
import * as React from 'react'
import { createPortal } from 'react-dom'
import { act, render } from '@testing-library/react'
import type { EditorConfig, LexicalEditor, NodeKey, SerializedLexicalNode } from 'lexical'
import {
  $createParagraphNode, $createTextNode, $getRoot, $getSelection, $isRangeSelection,
  createEditor, DecoratorNode,
} from 'lexical'
import { registerPlainText } from '@lexical/plain-text'

/** Minimal inline atomic chip for the spike (real node lands in Phase 1). */
class SpikeChipNode extends DecoratorNode<React.JSX.Element> {
  static getType(): string {
    return 'spike-chip'
  }

  static clone(node: SpikeChipNode): SpikeChipNode {
    return new SpikeChipNode(node.__key)
  }

  static importJSON(): SpikeChipNode {
    return new SpikeChipNode()
  }

  exportJSON(): SerializedLexicalNode {
    return { type: 'spike-chip', version: 1 }
  }

  createDOM(_config: EditorConfig): HTMLElement {
    const el = document.createElement('span')
    el.dataset['spikeChip'] = 'true'
    return el
  }

  updateDOM(): boolean {
    return false
  }

  isInline(): boolean {
    return true
  }

  getTextContent(): string {
    return '/chip-clipboard'
  }

  decorate(): React.JSX.Element {
    return <button type="button" data-chip-button>chip-label</button>
  }
}

function makeEditor(): { editor: LexicalEditor; rootEl: HTMLDivElement } {
  const editor = createEditor({
    namespace: 'spike',
    nodes: [SpikeChipNode],
    onError: (error) => { throw error },
  })
  const rootEl = document.createElement('div')
  rootEl.contentEditable = 'true'
  document.body.appendChild(rootEl)
  editor.setRootElement(rootEl)
  registerPlainText(editor)
  return { editor, rootEl }
}

describe('lexical jsdom spike', () => {
  it('renders update-driven text into the DOM and reports projections', async () => {
    const { editor, rootEl } = makeEditor()
    editor.update(() => {
      const p = $createParagraphNode()
      p.append($createTextNode('hello world'))
      $getRoot().append(p)
    }, { discrete: true })
    await Promise.resolve() // reconciliation is sync inside update; flush microtasks anyway
    expect(rootEl.textContent).toBe('hello world')
    const text = editor.getEditorState().read(() => $getRoot().getTextContent())
    expect(text).toBe('hello world')
  })

  it('answers whether synthetic beforeinput insertText drives Lexical under jsdom', () => {
    const { editor, rootEl } = makeEditor()
    editor.update(() => {
      const p = $createParagraphNode()
      p.append($createTextNode('ab'))
      $getRoot().append(p)
    }, { discrete: true })
    // Place a real DOM selection at the end of the text node.
    const walker = document.createTreeWalker(rootEl, NodeFilter.SHOW_TEXT)
    const textDom = walker.nextNode()
    const selectable = textDom !== null && textDom !== undefined
    if (selectable) {
      const sel = document.getSelection()
      const range = document.createRange()
      range.setStart(textDom, 2)
      range.collapse(true)
      sel?.removeAllRanges()
      sel?.addRange(range)
      document.dispatchEvent(new Event('selectionchange'))
    }
    const event = new InputEvent('beforeinput', {
      inputType: 'insertText', data: 'X', bubbles: true, cancelable: true,
    })
    rootEl.dispatchEvent(event)
    const after = editor.getEditorState().read(() => $getRoot().getTextContent())
    // Record the verdict either way — the spike's job is the answer, not a pass.
    console.log(`SPIKE beforeinput verdict: selectable=${selectable} after=${JSON.stringify(after)}`)
    expect(typeof after).toBe('string')
  })

  it('keeps decorator DOM identity when text is inserted before the chip', async () => {
    const { editor, rootEl } = makeEditor()
    // Decorator portal loop (what the real DecoratorPortals component will do).
    function Portals(): React.JSX.Element {
      const [decorators, setDecorators] = React.useState<Record<NodeKey, React.JSX.Element>>(
        () => editor.getDecorators<React.JSX.Element>(),
      )
      React.useLayoutEffect(
        () => editor.registerDecoratorListener<React.JSX.Element>((next) => { setDecorators(next) }),
        [],
      )
      return (
        <>
          {Object.entries(decorators).map(([key, jsx]) => {
            const el = editor.getElementByKey(key)
            return el === null ? null : createPortal(jsx, el, key)
          })}
        </>
      )
    }
    render(<Portals />)

    let chipKey = ''
    act(() => {
      editor.update(() => {
        const p = $createParagraphNode()
        const chip = new SpikeChipNode()
        chipKey = chip.getKey()
        p.append($createTextNode('before '), chip, $createTextNode(' after'))
        $getRoot().append(p)
      }, { discrete: true })
    })
    await Promise.resolve()
    const chipButton = rootEl.querySelector('[data-chip-button]')
    expect(chipButton).not.toBeNull()
    const chipSpan = rootEl.querySelector('[data-spike-chip]')

    // Insert text before the chip through the node API (the transaction path).
    act(() => {
      editor.update(() => {
        const p = $getRoot().getFirstChild()
        if (p === null) throw new Error('paragraph missing')
        const first = (p as ReturnType<typeof $createParagraphNode>).getFirstChild()
        if (first === null) throw new Error('text missing')
        ;(first as ReturnType<typeof $createTextNode>).spliceText(0, 0, '@')
      }, { discrete: true })
    })
    await Promise.resolve()
    // Chip DOM node identity survives (bug #2793's structural fix).
    expect(rootEl.querySelector('[data-spike-chip]')).toBe(chipSpan)
    expect(rootEl.querySelector('[data-chip-button]')).toBe(chipButton)
    // Chip node identity survives in the tree (bug #2813's structural fix).
    const stillThere = editor.getEditorState().read(() => {
      const node = editor.getEditorState()._nodeMap.get(chipKey)
      return node !== undefined
    })
    expect(stillThere).toBe(true)
    // Text content projection sees the clipboard form.
    const text = editor.getEditorState().read(() => $getRoot().getTextContent())
    expect(text).toBe('@before /chip-clipboard after')
  })

  it('reports whether selection APIs let update-driven caret placement work', () => {
    const { editor } = makeEditor()
    editor.update(() => {
      const p = $createParagraphNode()
      const t = $createTextNode('abc')
      p.append(t)
      $getRoot().append(p)
      t.select(1, 1)
    }, { discrete: true })
    const verdict = editor.getEditorState().read(() => {
      const sel = $getSelection()
      return $isRangeSelection(sel) ? `range@${sel.anchor.offset}` : String(sel)
    })
    console.log(`SPIKE selection verdict: ${verdict}`)
    expect(verdict).toBe('range@1')
  })
})
