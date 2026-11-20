import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { createVisiblePoller } from './visiblePoll.js'

function setup({ hidden = false } = {}) {
    let clock = 0
    let runs = 0
    const state = { hidden }
    const poller = createVisiblePoller(() => runs++, {
        visibleMs: 60_000,
        hiddenMs: 300_000,
        isHidden: () => state.hidden,
        now: () => clock,
    })
    return {
        poller,
        state,
        advance: (ms) => (clock += ms),
        runs: () => runs,
    }
}

describe('createVisiblePoller', () => {
    it('tab terlihat: menjalankan task tiap visibleMs', () => {
        const t = setup()
        t.advance(59_000)
        t.poller.tick()
        assert.equal(t.runs(), 0)
        t.advance(1_000)
        t.poller.tick()
        assert.equal(t.runs(), 1)
        t.advance(60_000)
        t.poller.tick()
        assert.equal(t.runs(), 2)
    })

    it('tab tersembunyi: jauh lebih jarang', () => {
        const t = setup({ hidden: true })
        t.advance(240_000)
        t.poller.tick()
        assert.equal(t.runs(), 0)
        t.advance(60_000)
        t.poller.tick()
        assert.equal(t.runs(), 1)
    })

    it('tab yang baru terlihat menyusul begitu jeda terlihat terlewati', () => {
        const t = setup({ hidden: true })
        t.advance(120_000)
        t.poller.tick()
        assert.equal(t.runs(), 0)
        t.state.hidden = false
        t.poller.tick()
        assert.equal(t.runs(), 1)
    })

    it('markRun menggeser giliran berikutnya', () => {
        const t = setup()
        t.advance(50_000)
        t.poller.markRun()
        t.advance(30_000)
        t.poller.tick()
        assert.equal(t.runs(), 0)
        t.advance(30_000)
        t.poller.tick()
        assert.equal(t.runs(), 1)
    })
})
