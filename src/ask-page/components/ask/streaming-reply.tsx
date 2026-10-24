import { formatDisplayNarrative } from "@/lib/ui/display-text"
import { useEffect } from 'react'
import { useReveal } from './reveal'
import { readBlocks } from '@/lib/ui/answer'
import { ResponseText } from '@/components/response/response-text'
import { formatPlanningReply } from '@/lib/ui/planning-message'
import type { Fact } from '@/lib/domain/answer-blocks'
import { EvidenceCitation } from './answer-evidence'

function inlineAmounts(text: string) {
  // Keep an ordinary currency amount together on mobile; very long exact
  // values may still wrap inside the bounded span instead of widening the page.
  return text.split(/(-?(?:[$€£]|USD|EUR|GBP|CHF|JPY|CAD|AUD|SEK|NOK|DKK)\s-?\d[\d.,]*)/g).map((part, index) =>
    index % 2 ? <strong key={index} className="inline-block max-w-full align-baseline font-medium tabular-nums">{part}</strong> : part)
}

export function StreamingReply({ text, live = false, className = '', nameContext, onDone, evidence = [] }: { text: string; live?: boolean; className?: string; nameContext?: unknown; onDone?: () => void; evidence?: { text: string; facts: Fact[] }[] }) {
  text = formatDisplayNarrative(formatPlanningReply(text), nameContext)
  const { shown, done } = useReveal(text, live)
  // What follows the prose (tables, cards) waits for its last word.
  useEffect(() => { if (done) onDone?.() }, [done, text, onDone])
  const blocks = readBlocks(shown)
  // Match complete paragraphs/list items from saved observations, never match
  // by a repeated number or attach evidence to partially revealed prose.
  const citedParts = new Map<string, Fact[]>()
  if (done) for (const item of evidence) {
    for (const block of readBlocks(formatDisplayNarrative(formatPlanningReply(item.text), nameContext))) {
      const parts = block.kind === 'paragraph' ? [block.text] : block.kind === 'bullets' || block.kind === 'numbers' ? block.items : []
      for (const part of parts) citedParts.set(part.trim(), [...(citedParts.get(part.trim()) ?? []), ...item.facts])
    }
  }
  const citation = (part: string) => {
    if (!done) return null
    const facts = citedParts.get(part.trim()) ?? []
    return facts.length ? <EvidenceCitation facts={facts} inline /> : null
  }
  return <div className={`answer-content min-w-0 break-words ${className}`}>
    {!done && <span className="sr-only">{text}</span>}
    <div aria-hidden={!done || undefined} className="answer-prose">
      {blocks.map((block, index) => {
        if (block.kind === 'heading') return <h3 key={index} className="text-large text-foreground"><ResponseText text={block.text} previews={done} /></h3>
        if (block.kind === 'bullets' || block.kind === 'numbers') {
          const List = block.kind === 'numbers' ? 'ol' : 'ul'
          return <List key={index} className={`space-y-1 pl-5 ${block.kind === 'numbers' ? 'list-decimal' : 'list-disc'}`}>{block.items.map((item, i) => <li key={i}><ResponseText text={item} previews={done}>{inlineAmounts(item)}</ResponseText>{citation(item)}</li>)}</List>
        }
        return <p key={index} className="whitespace-pre-line"><ResponseText text={block.text} previews={done}>{inlineAmounts(block.text)}</ResponseText>{citation(block.text)}{!done && index === blocks.length - 1 && <span className="ml-0.5 inline-block h-4 w-0.5 translate-y-0.5 bg-accent motion-safe:animate-pulse" />}</p>
      })}
    </div>
  </div>
}
