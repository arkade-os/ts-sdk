import { describe, expect, it } from 'vitest'
import { aggregateKeys } from '../src/core/signingSession'
import testData from './fixtures/musig2.json'
import { hex } from '@scure/base'

describe.skip('musig2', () => {
  describe('aggregateKeys', () => {
    it('should correctly aggregate public keys', () => {
      const { pubkeys, expectedAggregatedKey, tweak, expectedFinalKey } = testData.keyAggregation
      const publicKeys = pubkeys.map(key => hex.decode(key))
      const { aggregateKey, finalKey } = aggregateKeys(publicKeys, hex.decode(tweak))
      
      expect(hex.encode(aggregateKey)).toBe(expectedAggregatedKey)
      expect(hex.encode(finalKey)).toBe(expectedFinalKey)
    })
  })
})