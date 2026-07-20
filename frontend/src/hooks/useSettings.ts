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

async function apiGet<T>(path: string, signal?: AbortSignal): Promise<T> {
  const resp = await fetch(`${BASE_URL}${path}`, { signal })
  if (!resp.ok) {
    const detail = await resp.json().catch(() => ({ detail: resp.statusText }))
    throw new Error(typeof detail.detail === "string" ? detail.detail : `API request failed (${resp.status})`)
  }
  return resp.json() as Promise<T>
}

async function apiPost<T>(path: string, body: unknown, signal?: AbortSignal): Promise<T> {
  const resp = await fetch(`${BASE_URL}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal,
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

  // Distinct abort controllers for each lane
  const settingsAbortRef = useRef<AbortController | null>(null)
  const vendorsAbortRef = useRef<AbortController | null>(null)
  const modelsAbortRef = useRef<AbortController | null>(null)
  const saveAbortRef = useRef<AbortController | null>(null)

  const fetchSettings = useCallback(async () => {
    settingsAbortRef.current?.abort()
    const controller = new AbortController()
    settingsAbortRef.current = controller
    try {
      setLoading(true)
      setError(null)
      const data = await apiGet<SettingsResponse>("/settings", controller.signal)
      if (mountedRef.current && !controller.signal.aborted) {
        setSettings(mapResponse(data))
      }
    } catch (err) {
      if (err instanceof DOMException && err.name === "AbortError") return
      if (mountedRef.current) {
        setError(err instanceof Error ? err.message : "获取设置失败")
      }
    } finally {
      if (mountedRef.current && !controller.signal.aborted) {
        setLoading(false)
      }
    }
  }, [])

  const fetchVendors = useCallback(async () => {
    vendorsAbortRef.current?.abort()
    const controller = new AbortController()
    vendorsAbortRef.current = controller
    try {
      const data = await apiGet<VendorInfo[]>("/vendors", controller.signal)
      if (mountedRef.current && !controller.signal.aborted) setVendors(data)
    } catch (err) {
      if (err instanceof DOMException && err.name === "AbortError") return
      console.warn("Failed to load vendors:", err)
    }
  }, [])

  const fetchModels = useCallback(async (query?: string, baseUrl?: string) => {
    modelsAbortRef.current?.abort()
    const controller = new AbortController()
    modelsAbortRef.current = controller
    try {
      setModelsLoading(true)
      const params = new URLSearchParams()
      if (query) params.set("query", query)
      if (baseUrl) params.set("preview_base_url", baseUrl)
      const qs = params.toString()
      const data = await apiGet<ModelListResponse>(`/models${qs ? `?${qs}` : ""}`, controller.signal)
      if (mountedRef.current && !controller.signal.aborted) {
        setModels(data.models)
        setError(null)
      }
    } catch (err) {
      if (err instanceof DOMException && err.name === "AbortError") return
      if (mountedRef.current) {
        setError(err instanceof Error ? err.message : "获取模型列表失败")
      }
    } finally {
      if (mountedRef.current && !controller.signal.aborted) {
        setModelsLoading(false)
      }
    }
  }, [])

  const refreshModels = useCallback(async () => {
    modelsAbortRef.current?.abort()
    const controller = new AbortController()
    modelsAbortRef.current = controller
    try {
      setModelsLoading(true)
      const data = await apiGet<ModelListResponse>("/models?use_current_settings=true", controller.signal)
      if (mountedRef.current && !controller.signal.aborted) {
        setModels(data.models)
        setError(null)
      }
    } catch (err) {
      if (err instanceof DOMException && err.name === "AbortError") return
      if (mountedRef.current) {
        setError(err instanceof Error ? err.message : "刷新模型列表失败")
      }
    } finally {
      if (mountedRef.current && !controller.signal.aborted) {
        setModelsLoading(false)
      }
    }
  }, [])

  const updateSettings = useCallback(
    async (payload: UpdateSettingsPayload): Promise<UserSettings | undefined> => {
      // Abort any previous in-flight save — only the latest matters
      saveAbortRef.current?.abort()
      const controller = new AbortController()
      saveAbortRef.current = controller

      setSaving(true)
      setError(null)
      try {
        const data = await apiPost<SettingsResponse>("/settings", payload, controller.signal)
        const mapped = mapResponse(data)
        if (mountedRef.current && !controller.signal.aborted) {
          setSettings(mapped)
        }
        // Trigger model refresh without blocking the save resolution.
        // A discovery failure must not reject an already-persisted save.
        void refreshModels()
        return mapped
      } catch (err) {
        if (err instanceof DOMException && err.name === "AbortError") {
          // Superseded by a newer save or unmount — settle silently.
          // Callers must not see a user-facing error for an intentional abort.
          if (controller !== saveAbortRef.current || !mountedRef.current) return
          throw err
        }
        const msg = err instanceof Error ? err.message : "更新设置失败"
        if (mountedRef.current && controller === saveAbortRef.current) setError(msg)
        throw err
      } finally {
        if (mountedRef.current && controller === saveAbortRef.current) setSaving(false)
      }
    },
    [refreshModels],
  )

  /* eslint-disable react-hooks/set-state-in-effect */
  useEffect(() => {
    mountedRef.current = true
    void fetchSettings()
    void fetchVendors()
    return () => {
      mountedRef.current = false
      settingsAbortRef.current?.abort()
      vendorsAbortRef.current?.abort()
      modelsAbortRef.current?.abort()
      saveAbortRef.current?.abort()
    }
  }, [fetchSettings, fetchVendors])
  /* eslint-enable react-hooks/set-state-in-effect */

  // Once settings load with valid credentials, auto-refresh models (one-time)
  const initialModelsLoadedRef = useRef(false)
  useEffect(() => {
    if (settings?.base_url && settings.api_key && !initialModelsLoadedRef.current) {
      initialModelsLoadedRef.current = true
      void refreshModels()
    }
  }, [settings, refreshModels])

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
    refreshModels,
    fetchVendors,
    updateSettings,
  }
}
