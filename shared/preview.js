export const TEXT_PREVIEW_LIMIT = 10 * 1024 * 1024

const TEXT_MIMES = new Set([
  'application/json',
  'application/xml',
  'application/javascript',
  'application/x-javascript',
  'application/toml',
  'application/x-yaml',
  'application/yaml',
  'application/sql',
  'application/csv',
  'application/x-sh'
])

const TEXT_EXTS = new Set([
  'txt', 'md', 'log', 'json', 'xml', 'csv', 'tsv', 'yaml', 'yml', 'toml', 'ini', 'conf', 'cfg', 'env',
  'js', 'mjs', 'cjs', 'jsx', 'ts', 'tsx', 'css', 'scss', 'less', 'html', 'htm', 'vue', 'svelte',
  'sh', 'bash', 'zsh', 'bat', 'cmd', 'ps1',
  'py', 'rb', 'go', 'rs', 'java', 'kt', 'c', 'h', 'cpp', 'hpp', 'cc', 'cs', 'php', 'swift', 'scala', 'm',
  'sql', 'gitignore', 'dockerfile', 'properties', 'gradle', 'lock', 'editorconfig', 'gitattributes'
])

function extOf(filename) {
  const base = String(filename || '')
    .toLowerCase()
    .split(/[\\/]/)
    .pop() || ''
  if (base.startsWith('.') && base.indexOf('.', 1) === -1) return base.slice(1)
  const dot = base.lastIndexOf('.')
  return dot > 0 ? base.slice(dot + 1) : base
}

export function previewKind(mime, filename = '', size = 0) {
  const m = String(mime || '')
    .toLowerCase()
    .split(';')[0]
    .trim()
  if (m.startsWith('image/')) return 'image'
  if (m.startsWith('video/')) return 'video'
  const textLike = m.startsWith('text/') || TEXT_MIMES.has(m) || TEXT_EXTS.has(extOf(filename))
  if (textLike && Number(size) <= TEXT_PREVIEW_LIMIT) return 'text'
  return null
}

export function isPreviewable(mime, filename, size) {
  return previewKind(mime, filename, size) !== null
}
