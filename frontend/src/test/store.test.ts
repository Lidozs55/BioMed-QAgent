import { describe, it, expect } from 'vitest'
import { useAgentStore } from '@/stores/agentStore'

describe('agentStore', () => {
  it('initializes with empty state', () => {
    const state = useAgentStore.getState()
    expect(state.messages).toEqual([])
    expect(state.traces).toEqual([])
    expect(state.isConnected).toBe(false)
    expect(state.isRunning).toBe(false)
  })
})
