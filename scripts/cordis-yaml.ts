import * as yaml from 'js-yaml'

export interface JsExpr {
  __jsExpr: string
}

const jsExprType = new yaml.Type('tag:yaml.org,2002:js', {
  kind: 'scalar',
  resolve: data => typeof data === 'string',
  construct: (data: unknown): JsExpr => {
    if (typeof data !== 'string') throw new TypeError('!!js requires a scalar string')
    return { __jsExpr: data }
  },
})
const schema = yaml.JSON_SCHEMA.extend(jsExprType)

/** Parse a Cordis config while preserving Loader `!!js` expressions as data. */
export function loadCordisYaml(source: string): unknown {
  return yaml.load(source, { schema })
}

export function isJsExpr(value: unknown): value is JsExpr {
  return typeof value === 'object'
    && value !== null
    && typeof (value as Record<string, unknown>).__jsExpr === 'string'
}
