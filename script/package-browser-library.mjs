#!/usr/bin/env node

import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { gzipSync } from 'node:zlib'

function parseArguments(argv) {
  const values = new Map()
  const roots = []
  for (let index = 0; index < argv.length; index += 2) {
    const name = argv[index]
    const value = argv[index + 1]
    if (!name?.startsWith('--') || value === undefined) {
      throw new Error(`Expected --name value arguments; stopped at ${name ?? '<end>'}`)
    }
    if (name === '--root') roots.push(value)
    else if (values.has(name)) throw new Error(`Duplicate argument: ${name}`)
    else values.set(name, value)
  }

  function required(name) {
    const value = values.get(name)
    if (!value) throw new Error(`Missing required argument: ${name}`)
    return value
  }

  if (roots.length === 0) throw new Error('At least one --root module is required')
  return {
    workspace: path.resolve(required('--workspace')),
    core: path.resolve(required('--core')),
    leanSource: path.resolve(required('--lean-source')),
    output: path.resolve(required('--output')),
    manifest: path.resolve(required('--manifest')),
    roots,
    layerId: required('--layer-id'),
    leanRepository: required('--lean-repository'),
    leanCommit: required('--lean-commit'),
    leanUpstreamCommit: required('--lean-upstream-commit'),
    workflowCommit: required('--workflow-commit'),
    mathlibRepository: required('--mathlib-repository'),
    mathlibCommit: required('--mathlib-commit'),
    toolchainRunId: required('--toolchain-run-id'),
  }
}

const options = parseArguments(process.argv.slice(2))

for (const [label, root] of [
  ['Mathlib workspace', options.workspace],
  ['browser core library', options.core],
  ['Lean source', options.leanSource],
]) {
  if (!fs.existsSync(root)) throw new Error(`${label} not found: ${root}`)
}
if (
  options.output === options.workspace
  || options.output === options.core
  || options.output === options.leanSource
  || options.output === path.parse(options.output).root
) {
  throw new Error(`Refusing to replace unsafe output path: ${options.output}`)
}

function walk(root, predicate, relative = '', output = []) {
  const current = path.join(root, relative)
  for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
    if (entry.name === 'node_modules') continue
    const child = path.join(relative, entry.name)
    if (entry.isDirectory()) {
      if (!entry.name.startsWith('.')) walk(root, predicate, child, output)
    } else if (entry.isFile() && predicate(entry.name)) {
      output.push(child)
    }
  }
  return output
}

function packageDirectories(relative) {
  const result = []
  const packages = path.join(options.workspace, '.lake/packages')
  if (!fs.existsSync(packages)) return result
  for (const name of fs.readdirSync(packages).sort()) {
    const candidate = path.join(packages, name, relative)
    if (fs.existsSync(candidate)) result.push(candidate)
  }
  return result
}

const sourceRoots = [
  options.workspace,
  options.leanSource,
  ...packageDirectories(''),
]
const libraryRoots = [
  path.join(options.workspace, '.lake/build/lib/lean'),
  ...packageDirectories('.lake/build/lib/lean'),
].filter(fs.existsSync)
if (libraryRoots.length === 0) {
  throw new Error(`No built library roots found below ${options.workspace}`)
}

function moduleForLeanPath(relativePath) {
  return relativePath.replace(/\.lean$/, '').split(path.sep).join('.')
}

function stripLeanComments(source) {
  let output = ''
  let index = 0
  let blockDepth = 0
  while (index < source.length) {
    const current = source[index]
    const next = source[index + 1]
    if (blockDepth > 0) {
      if (current === '/' && next === '-') {
        blockDepth += 1
        output += '  '
        index += 2
      } else if (current === '-' && next === '/') {
        blockDepth -= 1
        output += '  '
        index += 2
      } else {
        output += current === '\n' ? '\n' : ' '
        index += 1
      }
    } else if (current === '/' && next === '-') {
      blockDepth = 1
      output += '  '
      index += 2
    } else if (current === '-' && next === '-') {
      while (index < source.length && source[index] !== '\n') {
        output += ' '
        index += 1
      }
    } else {
      output += current
      index += 1
    }
  }
  return output
}

function importedModules(source) {
  const imports = []
  let sawHeader = false
  for (const line of stripLeanComments(source).split('\n')) {
    const trimmed = line.trim()
    if (!trimmed) continue
    if (trimmed === 'module' || trimmed === 'prelude') {
      sawHeader = true
      continue
    }
    const match = /^(?:(?:public|meta|all)\s+)*import\s+(?:(?:public|meta|all)\s+)*([A-Za-z0-9_'.]+)$/.exec(trimmed)
    if (match) {
      sawHeader = true
      imports.push(match[1])
      continue
    }
    if (sawHeader || imports.length > 0) break
  }
  return imports
}

const moduleSources = new Map()
for (const sourceRoot of sourceRoots) {
  for (const relativePath of walk(sourceRoot, (name) => name.endsWith('.lean'))) {
    const moduleName = moduleForLeanPath(relativePath)
    if (!moduleSources.has(moduleName)) {
      moduleSources.set(moduleName, path.join(sourceRoot, relativePath))
    }
  }
}

const neededModules = new Set()
const pendingModules = [...options.roots, 'Init']
while (pendingModules.length > 0) {
  const moduleName = pendingModules.pop()
  if (!moduleName || neededModules.has(moduleName)) continue
  neededModules.add(moduleName)
  const sourcePath = moduleSources.get(moduleName)
  if (!sourcePath) throw new Error(`Could not resolve source for module ${moduleName}`)
  for (const imported of importedModules(fs.readFileSync(sourcePath, 'utf8'))) {
    if (!neededModules.has(imported)) pendingModules.push(imported)
  }
}

function readOleanIdentity(filePath) {
  const header = fs.readFileSync(filePath).subarray(0, 96)
  if (header.length < 48 || header.subarray(0, 5).toString('ascii') !== 'olean') {
    throw new Error(`Invalid .olean header: ${filePath}`)
  }
  const versionEnd = header.indexOf(0, 7)
  const version = header.subarray(7, versionEnd === -1 ? header.length : versionEnd).toString('ascii')
  const commit = header.toString('latin1').match(/[0-9a-f]{40}/)?.[0]
  if (!commit) throw new Error(`Lean commit is missing from .olean header: ${filePath}`)
  return {
    format: header.subarray(5, 7).toString('hex'),
    version,
    commit,
  }
}

function sameOleanIdentity(left, right) {
  return left.format === right.format && left.version === right.version && left.commit === right.commit
}

function describeOleanIdentity(identity) {
  return `${identity.version}, ${identity.commit}, format ${identity.format}`
}

const coreInit = path.join(options.core, 'Init.olean')
if (!fs.existsSync(coreInit)) throw new Error(`Browser core Init.olean not found: ${coreInit}`)
const browserIdentity = readOleanIdentity(coreInit)
if (browserIdentity.commit !== options.leanCommit) {
  throw new Error(`Browser core uses Lean ${browserIdentity.commit}; expected ${options.leanCommit}`)
}

function artifactRelativePath(moduleName, suffix) {
  return `${moduleName.split('.').join(path.sep)}${suffix}`
}

function findArtifact(relativePath) {
  let found = null
  for (const libraryRoot of libraryRoots) {
    const candidate = path.join(libraryRoot, relativePath)
    if (!fs.existsSync(candidate)) continue
    if (found && !fs.readFileSync(found).equals(fs.readFileSync(candidate))) {
      throw new Error(`Conflicting built artifacts for ${relativePath}`)
    }
    found = found ?? candidate
  }
  return found
}

const sources = new Map()
let coreModules = 0
for (const moduleName of [...neededModules].sort()) {
  const oleanPath = artifactRelativePath(moduleName, '.olean')
  if (fs.existsSync(path.join(options.core, oleanPath))) {
    coreModules += 1
    continue
  }

  const builtOlean = findArtifact(oleanPath)
  if (!builtOlean) throw new Error(`Built olean is missing for ${moduleName}`)
  sources.set(oleanPath, builtOlean)
  for (const suffix of ['.ir', '.ir.sig']) {
    const relativePath = artifactRelativePath(moduleName, suffix)
    const builtArtifact = findArtifact(relativePath)
    if (builtArtifact) sources.set(relativePath, builtArtifact)
  }
}
if (sources.size === 0) throw new Error('No supplemental artifacts were selected')

for (const [relativePath, sourcePath] of sources) {
  if (!relativePath.endsWith('.olean')) continue
  const identity = readOleanIdentity(sourcePath)
  if (!sameOleanIdentity(identity, browserIdentity)) {
    throw new Error(
      `Incompatible .olean header for ${relativePath}: ${describeOleanIdentity(identity)}; `
      + `browser core requires ${describeOleanIdentity(browserIdentity)}`,
    )
  }
}

const actualMathlibCommit = execFileSync('git', ['-C', options.workspace, 'rev-parse', 'HEAD'], {
  encoding: 'utf8',
}).trim()
if (actualMathlibCommit !== options.mathlibCommit) {
  throw new Error(`Mathlib checkout is ${actualMathlibCommit}; expected ${options.mathlibCommit}`)
}

const lakeManifestPath = path.join(options.workspace, 'lake-manifest.json')
const lakeManifest = JSON.parse(fs.readFileSync(lakeManifestPath, 'utf8'))
const packagePins = (lakeManifest.packages ?? []).map((entry) => ({
  name: entry.name,
  url: entry.url,
  rev: entry.rev,
  subDir: entry.subDir ?? null,
})).sort((left, right) => left.name.localeCompare(right.name))

fs.rmSync(options.output, { recursive: true, force: true })
fs.mkdirSync(options.output, { recursive: true })

const maxPackBytes = 16 * 1024 * 1024
let totalBytes = 0
let totalCompressedBytes = 0
let packParts = []
let packEntries = []
let packBytes = 0
const packs = []

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex')
}

function flushPack() {
  if (packEntries.length === 0) return
  const raw = Buffer.concat(packParts, packBytes)
  const compressed = gzipSync(raw, { level: 9, mtime: 0 })
  const file = `artifacts-${String(packs.length).padStart(3, '0')}.pack`
  fs.writeFileSync(path.join(options.output, file), compressed)
  packs.push({
    file,
    sha256: sha256(compressed),
    bytes: raw.byteLength,
    compressedBytes: compressed.byteLength,
    entries: packEntries,
  })
  totalCompressedBytes += compressed.byteLength
  packParts = []
  packEntries = []
  packBytes = 0
}

for (const [relativePath, sourcePath] of [...sources].sort(([left], [right]) => left.localeCompare(right))) {
  const bytes = fs.readFileSync(sourcePath)
  if (packBytes > 0 && packBytes + bytes.byteLength > maxPackBytes) flushPack()
  packEntries.push({
    path: relativePath.split(path.sep).join('/'),
    offset: packBytes,
    bytes: bytes.byteLength,
  })
  packParts.push(bytes)
  packBytes += bytes.byteLength
  totalBytes += bytes.byteLength
}
flushPack()

const files = [...sources.keys()].map((file) => file.split(path.sep).join('/')).sort()
const manifest = {
  schemaVersion: 1,
  kind: 'mathlib-dependency-closure',
  layerId: options.layerId,
  fullMathlib: false,
  lean: {
    repository: options.leanRepository,
    commit: options.leanCommit,
    upstreamCommit: options.leanUpstreamCommit,
    workflowCommit: options.workflowCommit,
    toolchainRunId: options.toolchainRunId,
    artifacts: ['build-Web Assembly', 'build-Linux 32bit'],
    olean: browserIdentity,
  },
  mathlib: {
    repository: options.mathlibRepository,
    commit: options.mathlibCommit,
    leanToolchain: fs.readFileSync(path.join(options.workspace, 'lean-toolchain'), 'utf8').trim(),
    roots: options.roots,
    packages: packagePins,
  },
  files,
  packs,
  dependencyModules: neededModules.size,
  coreModules,
  packagedModules: files.filter((file) => file.endsWith('.olean')).length,
  bytes: totalBytes,
  compressedBytes: totalCompressedBytes,
}

fs.mkdirSync(path.dirname(options.manifest), { recursive: true })
fs.writeFileSync(options.manifest, `${JSON.stringify(manifest, null, 2)}\n`)

console.log(
  `Packaged ${manifest.packagedModules} modules from ${manifest.dependencyModules} traced dependencies `
  + `in ${packs.length} packs (${Math.round(totalBytes / 1048576)} MB raw, `
  + `${Math.round(totalCompressedBytes / 1048576)} MB gzip)`,
)
console.log(`Layer: ${options.output}`)
console.log(`Manifest: ${options.manifest}`)
