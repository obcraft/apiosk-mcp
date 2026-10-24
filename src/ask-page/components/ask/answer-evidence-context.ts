import { createContext, useContext } from 'react'
import type { GatewayV2Analysis } from '@/lib/domain/gateway-v2'

export const AnswerEvidenceContext = createContext<{
  results: unknown[]; analysis?: GatewayV2Analysis | null; locale: string
}>({ results: [], locale: 'en-US' })

export const useAnswerEvidence = () => useContext(AnswerEvidenceContext)
