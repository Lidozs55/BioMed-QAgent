import { useCallback, useEffect, useRef, useState } from "react"

export interface ModelCapabilities {
  text: boolean
  image: boolean
  video: boolean
  audio: boolean
}

export interface ModelInfo {
  id: string
  name: string
  description: string
  context_window: number
  suggested_max_tokens: number
  capabilities: ModelCapabilities
  recommended: boolean
  api_available: boolean
}

export interface ModelListResponse {
  models: ModelInfo[]
  total_count: number
  api_source: string | null
}

export interface UserSettings {
  base_url: string
  api_key: string
  model_name: string
  max_tokens: number
}

export interface SettingsResponse {
  base_url: string
  api_key: string
  model_name: string
  max_tokens: number
}

export interface UpdateSettingsPayload {
  base_url?: string
  api_key?: string
  model_name?: string
  max_tokens?: number
}

const BASE_URL = "/api/v1"

async function apiGet<T>(path: string): Promise<T> {
  const resp = await fetch(`${BASE_URL}${path}`)
  if (!resp.ok) {
    const detail = await resp.json().catch(() => ({ detail: resp.statusText }))
    throw new Error(
      typeof detail.detail === "string"
        ? detail.detail
        : `API request failed (${resp.status})`,
    )
  }
  return resp.json() as Promise<T>
}

async function apiPost<T>(path: string, body: unknown): Promise<T> {
  const resp = await fetch(`${BASE_URL}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  })
  if (!resp.ok) {
    const detail = await resp.json().catch(() => ({ detail: resp.statusText }))
    throw new Error(
      typeof detail.detail === "string"
        ? detail.detail
        : `API request failed (${resp.status})`,
    )
  }
  return resp.json() as Promise<T>
}

export function useSettings() {
  const [settings, setSettings] = useState<UserSettings | null>(null)
  const [models, setModels] = useState<ModelInfo[]>([])
  const [modelsLoading, setModelsLoading] = useState(false)
  const [saving, setSaving] = useState(false)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const mountedRef = useRef(true)

  const fetchSettings = useCallback(async () => {
    try {
      setLoading(true)
      setError(null)
      const data = await apiGet<SettingsResponse>("/settings")
      if (mountedRef.current) {
        setSettings(data)
      }
    } catch (err) {
      if (mountedRef.current) {
        setError(err instanceof Error ? err.message : "获取设置失败")
      }
    } finally {
      if (mountedRef.current) {
        setLoading(false)
      }
    }
  }, [])

  const fetchModels = useCallback(async (query?: string) => {
    try {
      setModelsLoading(true)
      const qs = query ? `?query=${encodeURIComponent(query)}` : ""
      const data = await apiGet<ModelListResponse>(`/models${qs}`)
      if (mountedRef.current) {
        setModels(data.models)
      }
    } catch (err) {
      console.warn("Failed to load models:", err)
    } finally {
      if (mountedRef.current) {
        setModelsLoading(false)
      }
    }
  }, [])

  const updateSettings = useCallback(
    async (payload: UpdateSettingsPayload): Promise<UserSettings> => {
      setSaving(true)
      setError(null)
      try {
        const data = await apiPost<SettingsResponse>("/settings", payload)
        if (mountedRef.current) {
          setSettings(data)
        }
        // Refresh model list since the base URL / API key may have changed
        await fetchModels()
        return data
      } catch (err) {
        const msg = err instanceof Error ? err.message : "更新设置失败"
        if (mountedRef.current) {
          setError(msg)
        }
        throw err
      } finally {
        if (mountedRef.current) {
          setSaving(false)
        }
      }
    },
    [fetchModels],
  )

  useEffect(() => {
    mountedRef.current = true
    void fetchSettings()
    void fetchModels()
    return () => {
      mountedRef.current = false
    }
  }, [fetchSettings, fetchModels])

  return {
    settings,
    models,
    loading,
    modelsLoading,
    saving,
    error,
    fetchSettings,
    fetchModels,
    updateSettings,
  }
}
