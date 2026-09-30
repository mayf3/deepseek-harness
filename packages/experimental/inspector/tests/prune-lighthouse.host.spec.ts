/** Pure Lighthouse pruning fixtures retain adjacent panels, AI capabilities, and image registrations. */
import ts from 'typescript'
import { describe, expect, it } from 'vitest'
import { pruneLighthouse } from '../scripts/prune-lighthouse.ts'

const entryPath = 'entrypoints/devtools_app/devtools_app.js'
const panelPath = 'panels/ai_assistance/ai_assistance.js'
const modelPath = 'models/ai_assistance/ai_assistance.js'
const entry = `
import * as Lighthouse from "../../panels/lighthouse/lighthouse.js";
import * as Views from "../../ui/legacy/legacy.js";
const strings = { title: "Lighthouse" }, messages = Locale.registerUIStrings("panels/lighthouse/lighthouse-meta.ts", strings), cached = undefined;
async function loadLighthouse() { return cached || await import("../../panels/lighthouse/lighthouse.js"); }
Views.registerViewExtension({ id: "elements", title: "Elements" });
Views.registerViewExtension({ id: "lighthouse", async loadView() { return (await loadLighthouse()).LighthousePanel; } });
Core.registerRevealer({ contextTypes() { return [Lighthouse.LighthousePanel.ActiveLighthouseReport]; }, async loadRevealer() { return (await loadLighthouse()).ReportRevealer; } });
Views.registerViewExtension({ id: "timeline", title: "Performance" });
`

const panel = `
import * as Reports from "../lighthouse/lighthouse.js";
import * as Rendering from "../lighthouse/lighthouse.js";
import * as AI from "../../models/ai_assistance/ai_assistance.js";
function reportContext(report) { return report ? new AI.AccessibilityAgent.AccessibilityContext(report.report) : null; }
async function renderReport(widget) { return Rendering.LighthouseReportRenderer.renderLighthouseScores(widget.report); }
async function renderWidget(widget) { let rendered = null; switch (widget.name) {
case "LIGHTHOUSE_REPORT": rendered = await renderReport(widget); break;
case "OTHER": rendered = "other-widget"; break;
} return rendered; }
function icon(context) { return context instanceof AI.AccessibilityAgent.AccessibilityContext ? "Lighthouse" : "other-icon"; }
class Panel {
  #report = null;
  #onReport = event => { this.#report = reportContext(event.data); };
  async #record(params) { return await Reports.LighthousePanel.executeLighthouseRecording(params); }
  wasShown() { before(), this.#report = reportContext(Context.flavor(Reports.LighthousePanel.ActiveLighthouseReport)), Context.addFlavorChangeListener(Reports.LighthousePanel.ActiveLighthouseReport, this.#onReport), after(); }
  willHide() { before(), Context.removeFlavorChangeListener(Reports.LighthousePanel.ActiveLighthouseReport, this.#onReport), after(); }
  first() { return new AI.AiConversation.AiConversation({ lighthouseRecording: this.#record.bind(this), keep: "first" }); }
  second() { return new AI.AiConversation.AiConversation({ keep: "second", lighthouseRecording: this.#record.bind(this), other: true }); }
  third() { return new AI.AiConversation.AiConversation({ keep: "third", lighthouseRecording: this.#record.bind(this) }); }
  context(type) { switch (type) { case "accessibility": return this.#report; case "styling": return "styling-context"; } }
  setContext = value => value instanceof AI.AccessibilityAgent.AccessibilityContext ? this.#report = value : useOtherContext(value);
  view() { let elements = Views.isViewVisible("elements"), lighthouse = Views.isViewVisible("lighthouse"), storage = Views.isViewVisible("resources");
    return elements ? "styling" : lighthouse && config.devToolsAiAssistanceAccessibilityAgent?.enabled ? "accessibility" : storage ? "storage" : "none";
  }
}
class Unrelated { #report = "unrelated"; read() { return this.#report; } }
`

const model = `
class SelectionAgent { constructor() {
  this.declareFunction("listNetworkRequests", {}), this.declareFunction("runLighthouseAudits", {}), this.declareFunction("inspectDom", {});
} }
class AccessibilityAgent { configure() {
  this.declareFunction("executeJavaScript", {}), this.declareFunction("runAccessibilityAudits", {}), this.declareFunction("getLighthouseAudits", {}), this.declareFunction("getStyles", {});
} }
`

function imports(source: string): string[] {
  const file = ts.createSourceFile('fixture.js', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS)
  const result: string[] = []
  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteralLike(node.moduleSpecifier)) result.push(node.moduleSpecifier.text)
    if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword
      && node.arguments[0] !== undefined && ts.isStringLiteralLike(node.arguments[0])) result.push(node.arguments[0].text)
    ts.forEachChild(node, visit)
  }
  visit(file)
  return result
}

describe('pruneLighthouse', () => {
  it('removes the panel, revealer, lazy loader and private metadata while retaining adjacent panels', () => {
    const result = pruneLighthouse(entryPath, entry)
    expect(imports(result)).toEqual(['../../ui/legacy/legacy.js'])
    expect(result).toContain('Views.registerViewExtension({ id: "elements", title: "Elements" });')
    expect(result).toContain('Views.registerViewExtension({ id: "timeline", title: "Performance" });')
    expect(result).not.toMatch(/Lighthouse|loadLighthouse|registerRevealer|registerUIStrings|cached/)
  })

  it('removes only report context, recording and rendering from the AI panel', () => {
    const result = pruneLighthouse(panelPath, panel)
    expect(imports(result)).toEqual(['../../models/ai_assistance/ai_assistance.js'])
    expect(result).not.toMatch(/Reports|Rendering|renderReport|reportContext|lighthouseRecording|#record|#onReport/)
    expect(result).toContain('wasShown() { before(), after(); }')
    expect(result).toContain('willHide() { before(), after(); }')
    expect(result).toContain('case"LIGHTHOUSE_REPORT":break;')
    expect(result).toContain('case "OTHER": rendered = "other-widget"; break;')
    expect(result).toContain('case"accessibility":return null;')
    expect(result).toContain('case "styling": return "styling-context";')
    expect(result).toContain('setContext = value => useOtherContext(value);')
    expect(result).toContain('return "other-icon";')
    expect(result).toContain('{ keep: "first" }')
    expect(result).toContain('{ keep: "second", other: true }')
    expect(result).toContain('{ keep: "third" }')
    expect(result).toContain('storage ? "storage" : "none"')
    expect(result).toContain('class Unrelated { #report = "unrelated"; read() { return this.#report; } }')
  })

  it('removes Lighthouse model tool declarations without dropping other agent tools', () => {
    const result = pruneLighthouse(modelPath, model)
    expect(result).not.toMatch(/runLighthouseAudits|runAccessibilityAudits|getLighthouseAudits/)
    for (const tool of ['listNetworkRequests', 'inspectDom', 'executeJavaScript', 'getStyles']) {
      expect(result).toContain(`this.declareFunction("${tool}", {})`)
    }
    expect(result).toContain('class SelectionAgent')
    expect(result).toContain('class AccessibilityAgent')
  })

  it.each(['./lighthouse_logo.svg', 'lighthouse_logo.svg'])('replaces only the %s image call and preserves the comma chain', (url) => {
    const source = `style.setProperty("--before", "before.svg"),style.setProperty("--image-file-lighthouse_logo", new URL(new URL("${url}", import.meta.url).href)),style.setProperty("--after", "after.svg");`
    expect(pruneLighthouse('Images/Images.js', source))
      .toBe('style.setProperty("--before", "before.svg"),void 0,style.setProperty("--after", "after.svg");')
  })

  it('keeps unowned modules and i18n strings byte-identical', () => {
    const source = '{"showLighthouse":"Show Lighthouse","language":"all locales retained"}\n'
    expect(pruneLighthouse('core/i18n/locales/en-US.json', source)).toBe(source)
    expect(pruneLighthouse('panels/elements/elements.js', 'const Lighthouse = "unrelated";')).toBe('const Lighthouse = "unrelated";')
    expect(pruneLighthouse(entryPath.replaceAll('/', '\\'), entry)).toBe(pruneLighthouse(entryPath, entry))
  })

  it('rejects missing or duplicate pinned contributions', () => {
    expect(() => pruneLighthouse(entryPath, entry.replace('id: "lighthouse"', 'id: "renamed"'))).toThrow('expected 1 panel registrations, found 0')
    expect(() => pruneLighthouse(modelPath, model.replace('"runLighthouseAudits"', '"renamed"'))).toThrow('expected 1 runLighthouseAudits, found 0')
    const logo = 'style.setProperty("--image-file-lighthouse_logo", new URL("./lighthouse_logo.svg", import.meta.url));'
    expect(() => pruneLighthouse('Images/Images.js', logo + logo)).toThrow('expected 1 Lighthouse logo registrations, found 2')
    expect(() => pruneLighthouse(panelPath, panel.replace('async #record', 'async record'))).toThrow('private Lighthouse recording method')
  })

  it('rejects extra references instead of removing their unrelated consumers', () => {
    expect(() => pruneLighthouse(entryPath, entry + '\nuseElsewhere(Lighthouse);')).toThrow('removed binding Lighthouse remains referenced')
    expect(() => pruneLighthouse(entryPath, entry + '\nuseElsewhere(loadLighthouse);')).toThrow('removed binding loadLighthouse remains referenced')
    expect(() => pruneLighthouse(panelPath, panel.replace('first() {', 'extra() { return this.#report; } first() {')))
      .toThrow('removed private member #report remains referenced')
    expect(() => pruneLighthouse(panelPath, panel + '\nimport("../lighthouse/lighthouse.js");'))
      .toThrow('Lighthouse import remains after pruning')
  })

  it('rejects unexpected import forms, syntax, and effect-bearing tool expressions', () => {
    expect(() => pruneLighthouse(entryPath, entry.replace('import * as Lighthouse', 'import Lighthouse'))).toThrow('Lighthouse import must use a namespace')
    expect(() => pruneLighthouse(entryPath, 'function {')).toThrow('pruneLighthouse:')
    expect(() => pruneLighthouse(modelPath, model.replace('this.declareFunction("runLighthouseAudits", {})', 'wrap(this.declareFunction("runLighthouseAudits", {}))')))
      .toThrow('runLighthouseAudits is not an independent expression')
  })
})
