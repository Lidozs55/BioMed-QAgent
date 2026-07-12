import { describe, it, expect, beforeEach } from 'vitest'
import { useAgentStore } from '@/stores/agentStore'

describe('agentStore', () => {
  beforeEach(() => {
    // Reset store to defaults before each test
    useAgentStore.setState({
      messages: [],
      traces: [],
      isConnected: false,
      isRunning: false,
      databases: [],
      selectedDatabases: [],
      artifacts: [],
      taskId: null,
      sessions: [],
      currentSessionId: null,
      pipelineStage: 'idle',
    })
  })

  it('initializes with empty state', () => {
    const state = useAgentStore.getState()
    expect(state.messages).toEqual([])
    expect(state.traces).toEqual([])
    expect(state.isConnected).toBe(false)
    expect(state.isRunning).toBe(false)
    expect(state.sessions).toEqual([])
    expect(state.currentSessionId).toBeNull()
    expect(state.pipelineStage).toBe('idle')
  })

  it('addSession creates session and sets currentSessionId', () => {
    useAgentStore.getState().addSession('task-1', 'Test Topic', ['pubmed', 'pmc'])
    const state = useAgentStore.getState()
    expect(state.sessions).toHaveLength(1)
    expect(state.sessions[0].taskId).toBe('task-1')
    expect(state.sessions[0].topic).toBe('Test Topic')
    expect(state.sessions[0].databases).toEqual(['pubmed', 'pmc'])
    expect(state.sessions[0].messageCount).toBe(0)
    expect(typeof state.sessions[0].createdAt).toBe('number')
    expect(state.currentSessionId).toBe('task-1')

    // Adding another session
    useAgentStore.getState().addSession('task-2', 'Another Topic', [])
    expect(useAgentStore.getState().sessions).toHaveLength(2)
    expect(useAgentStore.getState().currentSessionId).toBe('task-2')
  })

  it('setPipelineStage updates pipelineStage', () => {
    useAgentStore.getState().setPipelineStage('discovery')
    expect(useAgentStore.getState().pipelineStage).toBe('discovery')

    useAgentStore.getState().setPipelineStage('analysis')
    expect(useAgentStore.getState().pipelineStage).toBe('analysis')
  })

  it('reset resets pipelineStage but preserves sessions', () => {
    useAgentStore.getState().addSession('task-1', 'Persist Topic', [])
    useAgentStore.getState().setPipelineStage('processing')
    useAgentStore.getState().reset()

    const state = useAgentStore.getState()
    // Sessions persist across reset
    expect(state.sessions).toHaveLength(1)
    expect(state.sessions[0].taskId).toBe('task-1')
    // PipelineStage resets to idle
    expect(state.pipelineStage).toBe('idle')
  })
})
