import { createContext } from 'react'

/** Result cells use compact links and source-preserving dates, never page previews. */
export const ResultTableContext = createContext(false)
