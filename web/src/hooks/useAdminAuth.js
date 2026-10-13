import { useEffect, useState } from 'react'
import { api } from '../api.js'

const STORAGE_KEY = 'file-share-admin-key'
const listeners = new Set()

let authorizedState = Boolean(localStorage.getItem(STORAGE_KEY))

function emit() {
  for (const listener of listeners) listener(authorizedState)
}

export function getAdminKey() {
  return localStorage.getItem(STORAGE_KEY) || ''
}

export function logout() {
  localStorage.removeItem(STORAGE_KEY)
  if (authorizedState) {
    authorizedState = false
    emit()
  }
}

async function validate(key) {
  await api.adminPing(key)
}

export function useAuthorized() {
  const [authorized, setAuthorized] = useState(authorizedState)
  useEffect(() => {
    const listener = (value) => setAuthorized(value)
    listeners.add(listener)
    return () => listeners.delete(listener)
  }, [])
  return authorized
}

export function useAdminAuth() {
  const authorized = useAuthorized()
  const [checking, setChecking] = useState(false)

  useEffect(() => {
    const key = getAdminKey()
    if (!key) return undefined
    let cancelled = false
    setChecking(true)
    validate(key)
      .then(() => {
        if (!cancelled && !authorizedState) {
          authorizedState = true
          emit()
        }
      })
      .catch((err) => {
        if (!cancelled && err.status === 401) logout()
      })
      .finally(() => {
        if (!cancelled) setChecking(false)
      })
    return () => {
      cancelled = true
    }
  }, [])

  const login = async (key) => {
    await validate(key)
    localStorage.setItem(STORAGE_KEY, key)
    if (!authorizedState) {
      authorizedState = true
      emit()
    }
  }

  return { authorized, checking, login, logout }
}
