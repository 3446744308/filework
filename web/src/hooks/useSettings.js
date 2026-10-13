import { useEffect, useState } from 'react'
import { api } from '../api.js'

let cache = null
const listeners = new Set()

async function load() {
  try {
    cache = await api.settings()
  } catch {
    cache = cache || { siteName: '', hasLogo: false, updatedAt: 0 }
  }
  for (const listener of listeners) listener(cache)
  return cache
}

export function refreshSettings() {
  return load()
}

export function useSettings() {
  const [settings, setSettings] = useState(cache)

  useEffect(() => {
    const listener = (value) => setSettings(value)
    listeners.add(listener)
    if (!cache) load()
    else setSettings(cache)
    return () => listeners.delete(listener)
  }, [])

  return settings
}

export function logoUrlOf(settings) {
  if (!settings || !settings.hasLogo) return null
  return `/api/logo?t=${settings.updatedAt}`
}
