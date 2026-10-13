import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { config } from './config.js'

export const FEEDBACK_TYPES = ['bug', 'feature', 'other']
export const FEEDBACK_STATUSES = ['pending', 'processing', 'done']

export const DEFAULT_REPLY_TEMPLATES = [
  '感谢你的反馈，我们已收到并评估，问题将在后续版本中修复。',
  '感谢你的建议！我们会认真考虑并纳入后续规划。',
  '该问题已在最新版本中修复，请更新后重试。',
  '感谢反馈，经排查该问题未能复现，如有更多信息欢迎补充。',
  '你的反馈已处理完成，如有其他问题欢迎随时反馈。'
]

const templatesPath = path.join(config.dataDir, 'feedback-templates.json')

export function getReplyTemplates() {
  try {
    const data = JSON.parse(fs.readFileSync(templatesPath, 'utf8'))
    if (Array.isArray(data.templates)) {
      const list = data.templates.map((t) => String(t ?? '').trim()).filter(Boolean).slice(0, 20)
      if (list.length) return list
    }
  } catch {}
  return [...DEFAULT_REPLY_TEMPLATES]
}

export function saveReplyTemplates(input) {
  const list = []
  if (Array.isArray(input)) {
    for (const raw of input.slice(0, 20)) {
      const t = String(raw ?? '').trim().slice(0, 500)
      if (t && !list.includes(t)) list.push(t)
    }
  }
  const data = { templates: list, updatedAt: Date.now() }
  const tmp = `${templatesPath}.${process.pid}.tmp`
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2))
  fs.renameSync(tmp, templatesPath)
  return list
}

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

export function updateFeedbackStatus(id, status, reply) {
  if (!FEEDBACK_STATUSES.includes(status)) return null
  const item = readFeedback(id)
  if (!item) return null
  if (status === 'done') {
    const text = String(reply ?? '').trim().slice(0, 2000)
    if (!text) {
      const err = new Error('完成状态需要填写回复内容')
      err.code = 'REPLY_REQUIRED'
      throw err
    }
    item.reply = text
    item.repliedAt = Date.now()
  }
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
