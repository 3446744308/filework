import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { config } from './config.js'

export const FEEDBACK_TYPES = ['bug', 'feature', 'other']
export const FEEDBACK_STATUSES = ['pending', 'processing', 'done']

const feedbackPath = (id) => path.join(config.feedbackDir, `${id}.json`)

function readFeedback(id) {
  try {
    return JSON.parse(fs.readFileSync(feedbackPath(id), 'utf8'))
  } catch {
    return null
  }
}

function writeFeedback(item) {
  const target = feedbackPath(item.id)
  const tmp = `${target}.${process.pid}.tmp`
  fs.writeFileSync(tmp, JSON.stringify(item))
  fs.renameSync(tmp, target)
}

function codeTaken(code) {
  let names = []
  try {
    names = fs.readdirSync(config.feedbackDir)
  } catch {
    return false
  }
  for (const name of names) {
    if (!name.endsWith('.json')) continue
    const item = readFeedback(name.slice(0, -5))
    if (item && item.code === code) return true
  }
  return false
}

function generateCode() {
  for (let i = 0; i < 50; i++) {
    const code = `FB-${crypto.randomInt(10000000, 100000000)}`
    if (!codeTaken(code)) return code
  }
  throw new Error('反馈号生成失败，请稍后重试')
}

export function createFeedback(input) {
  const type = FEEDBACK_TYPES.includes(input.type) ? input.type : 'other'
  const contact = String(input.contact ?? '').slice(0, 100).trim()
  const content = String(input.content ?? '').slice(0, 2000).trim()
  if (!content) {
    const err = new Error('请填写反馈内容')
    err.code = 'INVALID'
    throw err
  }
  const now = Date.now()
  const item = {
    id: `${now}-${crypto.randomBytes(4).toString('hex')}`,
    code: generateCode(),
    type,
    contact,
    content,
    status: 'pending',
    createdAt: now,
    updatedAt: now
  }
  writeFeedback(item)
  return item
}

export function findFeedbackByCode(code) {
  let names = []
  try {
    names = fs.readdirSync(config.feedbackDir)
  } catch {
    return null
  }
  for (const name of names) {
    if (!name.endsWith('.json')) continue
    const item = readFeedback(name.slice(0, -5))
    if (item && item.code === code) return item
  }
  return null
}

export function listFeedback() {
  const result = []
  let names = []
  try {
    names = fs.readdirSync(config.feedbackDir)
  } catch {
    return result
  }
  for (const name of names) {
    if (!name.endsWith('.json')) continue
    const item = readFeedback(name.slice(0, -5))
    if (item && item.id) result.push(item)
  }
  result.sort((a, b) => b.createdAt - a.createdAt)
  return result
}

export function updateFeedbackStatus(id, status) {
  if (!FEEDBACK_STATUSES.includes(status)) return null
  const item = readFeedback(id)
  if (!item) return null
  item.status = status
  item.updatedAt = Date.now()
  writeFeedback(item)
  return item
}

export function removeFeedback(id) {
  try {
    fs.unlinkSync(feedbackPath(id))
    return true
  } catch {
    return false
  }
}
