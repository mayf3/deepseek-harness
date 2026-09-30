/** Remove Lighthouse contributions from the pinned Chrome 150 frontend without changing other panels or AI tools. */
import ts from 'typescript'

const ENTRY = 'entrypoints/devtools_app/devtools_app.js'
const PANEL = 'panels/ai_assistance/ai_assistance.js'
const MODEL = 'models/ai_assistance/ai_assistance.js'
const IMAGES = 'Images/Images.js'
const LIGHTHOUSE_IMPORT = /(?:^|\/)lighthouse\/(?:lighthouse|lighthouse-dt-bundle)\.js$/u

interface Edit { readonly start: number; readonly end: number; readonly text: string }

/**
 * Remove the pinned revision's Lighthouse panel, report UI, and AI audit commands.
 * @param path - CDN-root-relative JavaScript path, with either path separator.
 * @param source - Original resource bytes decoded as UTF-8; no file is read or written.
 * @returns Transformed source for the four owning modules; unrelated modules retain their exact bytes.
 * @throws When an expected contribution differs, a removal overlaps, or a removed binding remains referenced.
 */
export function pruneLighthouse(path: string, source: string): string {
  path = path.replaceAll('\\', '/')
  if (![ENTRY, PANEL, MODEL, IMAGES].includes(path)) return source
  const file = parse(path, source)
  const edits: Edit[] = []
  const counts = new Map<string, number>()
  const removedNames = new Set<string>()
  const removedPrivateNames = new Map<ts.ClassLikeDeclaration, Set<string>>()
  function fail(message: string): never { throw new Error(`pruneLighthouse: ${path}: ${message}`) }
  const count = (name: string): void => { counts.set(name, (counts.get(name) ?? 0) + 1) }
  const edit = (node: ts.Node, text: string, name: string): void => {
    edits.push({ start: node.getStart(file), end: node.end, text })
    count(name)
  }
  const remove = (node: ts.Node, name: string): void => { edit(node, '', name) }
  const removeItem = (node: ts.Node, items: readonly ts.Node[], name: string): void => {
    const index = items.indexOf(node)
    if (index < 0) fail(`cannot locate ${name} in its containing list`)
    if (items.length === 1) { remove(node, name); return }
    edits.push(index === 0
      ? { start: node.getStart(file), end: items[1]!.getStart(file), text: '' }
      : { start: items[index - 1]!.end, end: node.end, text: '' })
    count(name)
  }
  const removeExpression = (node: ts.Expression, name: string): void => {
    const parent = node.parent
    if (ts.isExpressionStatement(parent)) { remove(parent, name); return }
    if (!ts.isBinaryExpression(parent) || parent.operatorToken.kind !== ts.SyntaxKind.CommaToken) {
      fail(`${name} is not an independent expression`)
    }
    edits.push(parent.left === node
      ? { start: node.getStart(file), end: parent.right.getStart(file), text: '' }
      : { start: parent.left.end, end: node.end, text: '' })
    count(name)
  }
  const requireCount = (name: string, expected: number): void => {
    if ((counts.get(name) ?? 0) !== expected) fail(`expected ${expected} ${name}, found ${counts.get(name) ?? 0}`)
  }
  const nodes = descendants(file)
  const imports = file.statements.filter(ts.isImportDeclaration).filter(node =>
    ts.isStringLiteralLike(node.moduleSpecifier) && LIGHTHOUSE_IMPORT.test(node.moduleSpecifier.text))
  const namespaces = new Set<string>()
  for (const declaration of imports) {
    const binding = declaration.importClause?.namedBindings
    if (binding === undefined || !ts.isNamespaceImport(binding)) fail('Lighthouse import must use a namespace')
    namespaces.add(binding.name.text)
    removedNames.add(binding.name.text)
    remove(declaration, 'Lighthouse imports')
  }
  const ownsLighthouse = (node: ts.Node): boolean => descendants(node).some(child =>
    ts.isIdentifier(child) && namespaces.has(child.text))

  if (path === IMAGES) {
    requireCount('Lighthouse imports', 0)
    for (const node of nodes) {
      if (ts.isCallExpression(node) && methodName(node) === 'setProperty'
        && node.arguments[0] !== undefined && ts.isStringLiteralLike(node.arguments[0])
        && node.arguments[0].text === '--image-file-lighthouse_logo' && descendants(node).some(child =>
        ts.isStringLiteralLike(child) && child.text.replace(/^\.\//u, '') === 'lighthouse_logo.svg')) {
        edit(node, 'void 0', 'Lighthouse logo registrations')
      }
    }
    requireCount('Lighthouse logo registrations', 1)
  } else if (path === ENTRY) {
    for (const node of nodes) {
      if (ts.isFunctionDeclaration(node) && descendants(node).some(isLighthouseDynamicImport)) {
        if (node.name === undefined) fail('Lighthouse loader must have a name')
        removedNames.add(node.name.text)
        remove(node, 'lazy loaders')
      }
      if (ts.isVariableStatement(node) && node.parent === file && descendants(node).some(child =>
        ts.isStringLiteralLike(child) && child.text === 'panels/lighthouse/lighthouse-meta.ts')) {
        for (const declaration of node.declarationList.declarations) {
          if (!ts.isIdentifier(declaration.name)) fail('Lighthouse metadata must use named declarations')
          removedNames.add(declaration.name.text)
        }
        remove(node, 'metadata declarations')
      }
      if (!ts.isExpressionStatement(node) || !ts.isCallExpression(node.expression)) continue
      const call = node.expression
      if (methodName(call) === 'registerViewExtension' && descendants(call).some(child =>
        ts.isPropertyAssignment(child) && child.name.getText(file) === 'id'
        && ts.isStringLiteralLike(child.initializer) && child.initializer.text === 'lighthouse')) {
        remove(node, 'panel registrations')
      }
      if (methodName(call) === 'registerRevealer' && ownsLighthouse(call)) remove(node, 'report revealers')
    }
    for (const name of ['Lighthouse imports', 'lazy loaders', 'metadata declarations', 'panel registrations', 'report revealers']) {
      requireCount(name, 1)
    }
  } else if (path === MODEL) {
    requireCount('Lighthouse imports', 0)
    for (const node of nodes) {
      if (!ts.isCallExpression(node) || methodName(node) !== 'declareFunction') continue
      const name = node.arguments[0]
      if (name !== undefined && ts.isStringLiteralLike(name)
        && ['runLighthouseAudits', 'runAccessibilityAudits', 'getLighthouseAudits'].includes(name.text)) {
        removeExpression(node, name.text)
      }
    }
    for (const name of ['runLighthouseAudits', 'runAccessibilityAudits', 'getLighthouseAudits']) requireCount(name, 1)
  } else {
    const renderer = nodes.filter(ts.isFunctionDeclaration).filter(node => ownsLighthouse(node))
    if (renderer.length !== 1 || renderer[0]!.name === undefined) fail('expected one Lighthouse report renderer')
    const rendererName = renderer[0]!.name!.text
    removedNames.add(rendererName)
    remove(renderer[0]!, 'report renderers')
    const recording = nodes.filter(ts.isMethodDeclaration).filter(node => descendants(node).some(child =>
      ts.isCallExpression(child) && methodName(child) === 'executeLighthouseRecording' && ownsLighthouse(child)))
    if (recording.length !== 1 || !ts.isPrivateIdentifier(recording[0]!.name)) fail('expected one private Lighthouse recording method')
    const recordMethod = recording[0]!
    const owner = recordMethod.parent
    if (!ts.isClassExpression(owner) && !ts.isClassDeclaration(owner)) fail('recording method has no owning class')
    const privateNames = new Set([recordMethod.name.getText(file)])
    removedPrivateNames.set(owner, privateNames)
    remove(recordMethod, 'recording methods')

    const reportReads = nodes.filter(ts.isBinaryExpression).filter(node => node.operatorToken.kind === ts.SyntaxKind.EqualsToken
      && ts.isPropertyAccessExpression(node.left) && ts.isPrivateIdentifier(node.left.name)
      && ownsLighthouse(node.right))
    if (reportReads.length !== 1) fail('expected one enclosing report-context assignment')
    const reportRead = reportReads[0]!
    if (!ts.isPropertyAccessExpression(reportRead.left) || !ts.isCallExpression(reportRead.right)
      || !ts.isIdentifier(reportRead.right.expression)) fail('unexpected report-context assignment')
    const reportField = reportRead.left.name.text
    const contextFactory = reportRead.right.expression.text
    privateNames.add(reportField)
    removedNames.add(contextFactory)
    removeExpression(reportRead, 'report-context reads')

    for (const node of nodes) {
      if (ts.isFunctionDeclaration(node) && node.name?.text === contextFactory) remove(node, 'context factories')
      if (ts.isCallExpression(node) && ['addFlavorChangeListener', 'removeFlavorChangeListener'].includes(methodName(node) ?? '')
        && ownsLighthouse(node)) {
        const listener = node.arguments[1]
        if (listener === undefined || !ts.isPropertyAccessExpression(listener) || !ts.isPrivateIdentifier(listener.name)) {
          fail('Lighthouse context listener must be a private member')
        }
        privateNames.add(listener.name.text)
        removeExpression(node, 'report-context listeners')
      }
      if (ts.isPropertyAssignment(node) && node.name.getText(file) === 'lighthouseRecording') {
        if (!ts.isCallExpression(node.initializer) || !node.initializer.getText(file).includes(recordMethod.name.getText(file))) {
          fail('unexpected Lighthouse recording callback')
        }
        if (!ts.isObjectLiteralExpression(node.parent)) fail('recording callback has no options object')
        removeItem(node, node.parent.properties, 'recording callbacks')
      }
      if (ts.isCaseClause(node) && ts.isStringLiteralLike(node.expression) && node.expression.text === 'LIGHTHOUSE_REPORT'
        && descendants(node).some(child => ts.isIdentifier(child) && child.text === rendererName)) {
        edit(node, 'case"LIGHTHOUSE_REPORT":break;', 'report widget branches')
      }
      if (ts.isCaseClause(node) && ts.isStringLiteralLike(node.expression) && node.expression.text === 'accessibility'
        && descendants(node).some(child => ts.isPrivateIdentifier(child) && child.text === reportField)) {
        edit(node, 'case"accessibility":return null;', 'report-context branches')
      }
      if (ts.isConditionalExpression(node) && descendants(node.condition).some(child =>
        ts.isPropertyAccessExpression(child) && child.name.text === 'AccessibilityContext')) {
        edit(node, node.whenFalse.getText(file), 'report-context selections')
      }
      if (ts.isConditionalExpression(node) && descendants(node.condition).some(child =>
        ts.isPropertyAccessExpression(child) && child.name.text === 'devToolsAiAssistanceAccessibilityAgent')) {
        edit(node, node.whenFalse.getText(file), 'Lighthouse view selections')
      }
      if (ts.isVariableDeclaration(node) && node.initializer !== undefined && ts.isCallExpression(node.initializer)
        && methodName(node.initializer) === 'isViewVisible' && node.initializer.arguments[0] !== undefined
        && ts.isStringLiteralLike(node.initializer.arguments[0]) && node.initializer.arguments[0].text === 'lighthouse') {
        if (!ts.isVariableDeclarationList(node.parent)) fail('Lighthouse visibility has no declaration list')
        removeItem(node, node.parent.declarations, 'Lighthouse visibility reads')
      }
    }
    for (const member of owner.members) {
      if (ts.isPropertyDeclaration(member) && ts.isPrivateIdentifier(member.name) && privateNames.has(member.name.text)) {
        remove(member, 'report state members')
      }
    }
    for (const [name, expected] of [
      ['Lighthouse imports', 2], ['context factories', 1], ['report-context listeners', 2], ['recording callbacks', 3],
      ['report widget branches', 1], ['report-context branches', 1], ['report-context selections', 2],
      ['Lighthouse view selections', 1], ['Lighthouse visibility reads', 1], ['report state members', 2],
    ] as const) requireCount(name, expected)
  }

  edits.sort((a, b) => a.start - b.start)
  let cursor = 0
  let result = ''
  for (const edit of edits) {
    if (edit.start < cursor) fail('Lighthouse removals overlap')
    result += source.slice(cursor, edit.start) + edit.text
    cursor = edit.end
  }
  result += source.slice(cursor)
  const output = parse(path, result)
  for (const node of descendants(output)) {
    if (ts.isImportDeclaration(node) && ts.isStringLiteralLike(node.moduleSpecifier) && LIGHTHOUSE_IMPORT.test(node.moduleSpecifier.text)
      || isLighthouseDynamicImport(node)) fail('Lighthouse import remains after pruning')
    if (ts.isIdentifier(node) && removedNames.has(node.text)) fail(`removed binding ${node.text} remains referenced`)
  }
  // Private names belong to one class, so an unrelated AI class may reuse the same minified name.
  for (const [owner, names] of removedPrivateNames) {
    const ordinal = nodes.filter(isClass).filter(node => node.getStart(file) < owner.getStart(file)).length
    const rewritten = descendants(output).filter(isClass)[ordinal]
    if (rewritten === undefined) fail('AI class disappeared while pruning Lighthouse')
    for (const node of descendants(rewritten)) {
      if (ts.isPrivateIdentifier(node) && names.has(node.text)) fail(`removed private member ${node.text} remains referenced`)
    }
  }
  return result
}

function descendants(node: ts.Node): ts.Node[] {
  const result: ts.Node[] = []
  const visit = (child: ts.Node): void => { result.push(child); ts.forEachChild(child, visit) }
  visit(node)
  return result
}

function methodName(node: ts.CallExpression): string | undefined {
  return ts.isPropertyAccessExpression(node.expression) ? node.expression.name.text : undefined
}

function isLighthouseDynamicImport(node: ts.Node): boolean {
  return ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword
    && node.arguments[0] !== undefined && ts.isStringLiteralLike(node.arguments[0])
    && LIGHTHOUSE_IMPORT.test(node.arguments[0].text)
}

function isClass(node: ts.Node): node is ts.ClassLikeDeclaration {
  return ts.isClassDeclaration(node) || ts.isClassExpression(node)
}

function parse(path: string, source: string): ts.SourceFile {
  const result = ts.transpileModule(source, {
    fileName: path, reportDiagnostics: true,
    compilerOptions: { allowJs: true, target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.ESNext },
  })
  const error = result.diagnostics?.find(diagnostic => diagnostic.category === ts.DiagnosticCategory.Error)
  if (error !== undefined) throw new Error(`pruneLighthouse: ${path}: ${ts.flattenDiagnosticMessageText(error.messageText, '\n')}`)
  return ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS)
}
