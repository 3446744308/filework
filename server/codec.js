import zlib from 'node:zlib'
import { promisify } from 'node:util'

const gzipAsync = promisify(zlib.gzip)
const gunzipAsync = promisify(zlib.gunzip)
const brotliAsync = promisify(zlib.brotliCompress)
const unbrotliAsync = promisify(zlib.brotliDecompress)

export const CODEC_RAW = 'r'
export const CODEC_GZIP = 'g'
export const CODEC_BROTLI = 'b'

export const GZIP_LEVEL = 6
export const BROTLI_QUALITY = 5
const BROTLI_MARGIN = 0.96

export const DEFAULT_CODECS = ['br', 'gzip']

export const ENCODING_GZIP = 'gzip'
export const ENCODING_BROTLI = 'br'

const ENCODING_ALIAS = {
  'x-gzip': ENCODING_GZIP,
  xgzip: ENCODING_GZIP
}

const ACCEPT_Q = /^\s*q\s*=\s*([0-9]*\.?[0-9]+)\s*$/i

export function gzipBuffer(buffer) {
  return gzipAsync(buffer, { level: GZIP_LEVEL })
}

export function gunzipBuffer(buffer) {
  return gunzipAsync(buffer)
}

export function brotliBuffer(buffer) {
  return brotliAsync(buffer, {
    params: {
      [zlib.constants.BROTLI_PARAM_QUALITY]: BROTLI_QUALITY,
      [zlib.constants.BROTLI_PARAM_SIZE_HINT]: buffer.length
    }
  })
}

export function unbrotliBuffer(buffer) {
  return unbrotliAsync(buffer)
}

export function decodePayload(codec, buffer) {
  if (codec === CODEC_GZIP) return gunzipBuffer(buffer)
  if (codec === CODEC_BROTLI) return unbrotliBuffer(buffer)
  return Promise.resolve(buffer)
}

export function codecToEncoding(codec) {
  if (codec === CODEC_GZIP) return ENCODING_GZIP
  if (codec === CODEC_BROTLI) return ENCODING_BROTLI
  return ''
}

export async function encodeUnit(raw, codecs = DEFAULT_CODECS) {
  let best = { codec: CODEC_RAW, buffer: raw }
  if (codecs.includes('gzip')) {
    const packed = await gzipBuffer(raw)
    if (packed.length < best.buffer.length) best = { codec: CODEC_GZIP, buffer: packed }
  }
  if (codecs.includes('br')) {
    const packed = await brotliBuffer(raw)
    const wins =
      best.codec === CODEC_GZIP
        ? packed.length < best.buffer.length * BROTLI_MARGIN
        : packed.length < best.buffer.length
    if (wins) best = { codec: CODEC_BROTLI, buffer: packed }
  }
  return best
}

export async function encodeForTransfer(raw, encoding) {
  if (encoding === ENCODING_GZIP) {
    const packed = await gzipBuffer(raw)
    return packed.length < raw.length ? packed : null
  }
  if (encoding === ENCODING_BROTLI) {
    const packed = await brotliBuffer(raw)
    return packed.length < raw.length ? packed : null
  }
  return null
}

export function parseAcceptEncoding(header) {
  if (header === undefined || header === null) return null
  const accepted = new Map()
  for (const item of String(header).split(',')) {
    const [namePart, ...params] = item.split(';')
    const raw = namePart.trim().toLowerCase()
    if (!raw) continue
    const name = ENCODING_ALIAS[raw] || raw
    let q = 1
    for (const param of params) {
      const matched = ACCEPT_Q.exec(param)
      if (matched) q = Number.parseFloat(matched[1])
    }
    if (!Number.isFinite(q) || q < 0) q = 0
    accepted.set(name, Math.max(accepted.get(name) ?? 0, Math.min(q, 1)))
  }
  return accepted
}

export function acceptsEncoding(accepted, name) {
  if (!accepted || accepted.size === 0) return false
  if (accepted.has(name)) return accepted.get(name) > 0
  const star = accepted.get('*')
  return star !== undefined && star > 0
}

export function planTransferCodec(storedCodec, accepted) {
  if (storedCodec === CODEC_GZIP && acceptsEncoding(accepted, ENCODING_GZIP)) {
    return { encoding: ENCODING_GZIP, passthrough: true }
  }
  if (storedCodec === CODEC_BROTLI && acceptsEncoding(accepted, ENCODING_BROTLI)) {
    return { encoding: ENCODING_BROTLI, passthrough: true }
  }
  if (acceptsEncoding(accepted, ENCODING_GZIP)) {
    return { encoding: ENCODING_GZIP, passthrough: false }
  }
  if (acceptsEncoding(accepted, ENCODING_BROTLI)) {
    return { encoding: ENCODING_BROTLI, passthrough: false }
  }
  return { encoding: '', passthrough: false }
}
