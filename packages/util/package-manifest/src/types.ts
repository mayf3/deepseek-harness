/**
 * Shared declarations for the package.json fields used by DSH plugin authors.
 * Each reader owns JSON validation and resolved defaults.
 * @module @deepseek-ai/dsh-package-manifest/types
 */

/** Package identity and metadata; local profile readers may accept a partial declaration. */
export interface DshPackageManifest {
  /** Published npm package name. */
  name: string
  /** Published npm package version. */
  version: string
  /** Package summary for discovery and display. */
  description?: string
  /** Prevent npm publication, for example for local profile projects. */
  private?: boolean
  /** Packages installed alongside this package. */
  dependencies?: Record<string, string>
  /** Compatible versions of packages supplied by the consuming project. */
  peerDependencies?: Record<string, string>
  /** Runtime requirements; DSH compatibility is declarative until a reader enforces it. */
  engines?: DshEnginesManifest
  /** DSH-specific author declarations. */
  dsh?: DshManifest
}

/** Public author fields under `package.json.dsh`; a package may declare several roles. */
export interface DshManifest {
  /** Manifest format version, independent of the npm package and Session format versions. */
  manifestVersion?: 1
  /** Bundle metadata consumed by the profile launcher. */
  bundle?: DshBundleManifest
  /** Profile metadata consumed by the profile launcher. */
  profile?: DshProfileManifest
  /** Client module loading and build metadata. */
  client?: DshClientManifest
  /** Display title of the package, read without executing package code. */
  title?: string
  /** Agent-plane modules the package declares addable to a composition, read without executing package code. */
  plugins?: DshPluginDeclaration[]
}

/** Runtime version requirements under `package.json.engines`. */
export interface DshEnginesManifest {
  /** Compatible DSH versions as a SemVer range, including an exact version. */
  dsh?: string
  /** Compatible Node.js versions. */
  node?: string
  /** Compatible npm versions. */
  npm?: string
  /** Requirements for additional runtimes or package managers. */
  [engine: string]: string | undefined
}

/** One agent-plane module a package declares addable to a composition. */
export interface DshPluginDeclaration {
  /** The package's export subpath, with `.` naming its main entry and `./tools` a subpath. */
  name: string
  /** Display title. */
  title?: string
  /** Default row config. */
  config?: unknown
}

/** The configuration layer exported by a bundle package. */
export interface DshBundleManifest {
  /** Patch file path relative to the declaring package root. */
  patch: string
}

/** The bundle composition declared by a profile directory. */
export interface DshProfileManifest {
  /** Ordered bundle layer list, using installed package names. */
  bundles?: string[]
  /**
   * Installed bundles the user disabled: dependencies that declare
   * `dsh.bundle` and stay out of `bundles`, through every later pnpm run,
   * until enabled again.
   */
  disabledBundles?: string[]
  /** User patch lifecycle; omitted means `live` for custom profiles. */
  patchReload?: ProfilePatchReload
}

/** Whether user patch files reload while a profile remains active or apply only at startup. */
export type ProfilePatchReload = 'live' | 'startup'

/** Client module declaration read by client-modules and the client build. */
export interface DshClientManifest {
  /** Client platform identifier; the Web consumer selects `web`. */
  platform: string
  /** Informational package-name dependencies, not Cordis service injection. */
  inject?: string[]
  /** Boot phase-one registration barrier; absent means the shared application batch. */
  immediately?: boolean
  /**
   * Exact module-table requests beyond the implicit client baseline, including
   * subpaths such as `<pkg>/client`; absent means baseline externals only.
   * Type-only imports are erased and create no module request.
   */
  external?: string[]
}
