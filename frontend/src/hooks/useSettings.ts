import { useCallback, useEffect, useRef, useState } from "react"

export interface ModelCapabilities {
  text: boolean
  image: boolean
  video: boolean
  audio: boolean
}

export interface VendorInfo {
  id: string; name: string; base_url: string
  description: string; recommended: boolean
}

export interface AdvancedParams {
  temperature: number; top_p: number; repetition_penalty: number
  enable_search: boolean; thinking_mode: boolean
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
  capability_source: string
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
  advanced: AdvancedParams
}

export interface SettingsResponse {
  base_url: string
  api_key: string
  model_name: string
  max_tokens: number
  temperature: number
  top_p: number
  repetition_penalty: number
  enable_search: boolean
  thinking_mode: boolean
}

export interface UpdateSettingsPayload {
  base_url?: string
  api_key?: string
  model_name?: string
  max_tokens?: number
  temperature?: number
  top_p?: number
  repetition_penalty?: number
  enable_search?: boolean
  thinking_mode?: boolean
}

const BASE_URL = "/api/v1"

async function apiGet<T>(path: string): Promise<T> {
  const resp = await fetch(`${BASE_URL}${path}`)
  if (!resp.ok) {
    const detail = await resp.json().catch(() => ({ detail: resp.statusText }))
    throw new Error(typeof detail.detail === "string" ? detail.detail : `API request failed (${resp.status})`)
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
    throw new Error(typeof detail.detail === "string" ? detail.detail : `API request failed (${resp.status})`)
  }
  return resp.json() as Promise<T>
}

function mapResponse(resp: SettingsResponse): UserSettings {
  return {
    base_url: resp.base_url,
    api_key: resp.api_key,
    model_name: resp.model_name,
    max_tokens: resp.max_tokens,
    advanced: {
      temperature: resp.temperature ?? 0.7,
      top_p: resp.top_p ?? 1.0,
      repetition_penalty: resp.repetition_penalty ?? 1.0,
      enable_search: resp.enable_search ?? false,
      thinking_mode: resp.thinking_mode ?? false,
    },
  }
}

export function useSettings() {
  const [settings, setSettings] = useState<UserSettings | null>(null)
  const [models, setModels] = useState<ModelInfo[]>([])
  const [vendors, setVendors] = useState<VendorInfo[]>([])
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
        setSettings(mapResponse(data))
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

  const fetchVendors = useCallback(async () => {
    try {
      const data = await apiGet<VendorInfo[]>("/vendors")
      if (mountedRef.current) setVendors(data)
    } catch (err) { console.warn("Failed to load vendors:", err) }
  }, [])

  const fetchModels = useCallback(async (query?: string, baseUrl?: string, apiKey?: string) => {
    try {
      setModelsLoading(true)
      const params = new URLSearchParams()
      if (query) params.set("query", query)
      if (baseUrl) params.set("preview_base_url", baseUrl)
      if (apiKey) params.set("preview_api_key", apiKey)
      const qs = params.toString()
      const data = await apiGet<ModelListResponse>("/models" + (qs ? "?" + qs : ""))
      if (mountedRef.current) setModels(data.models)
    } catch (err) { console.warn("Failed to load models:", err) }
    finally { if (mountedRef.current) setModelsLoading(false) }
  }, [])

  const updateSettings = useCallback(
    async (payload: UpdateSettingsPayload): Promise<UserSettings> => {
      setSaving(true)
      setError(null)
      try {
        const data = await apiPost<SettingsResponse>("/settings", payload)
        const mapped = mapResponse(data)
        if (mountedRef.current) setSettings(mapped)
        await fetchModels()
        return mapped
      } catch (err) {
        const msg = err instanceof Error ? err.message : "更新设置失败"
        if (mountedRef.current) setError(msg)
        throw err
      } finally {
        if (mountedRef.current) setSaving(false)
      }
    },
    [fetchModels],
  )

  useEffect(() => {
    mountedRef.current = true
    void fetchSettings()
    void fetchVendors()
    return () => { mountedRef.current = false }
  }, [fetchSettings, fetchVendors])

  return {
    settings,
    models,
    vendors,
    loading,
    modelsLoading,
    saving,
    error,
    fetchSettings,
    fetchModels,
    fetchVendors,
    updateSettings,
  }
}
