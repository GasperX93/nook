/**
 * Renders a chat message's text with the small Markdown subset from
 * lib/message-format. Everything is built as React elements from parsed
 * tokens — the text itself is never treated as HTML.
 */
import type { ReactNode } from 'react'

import { parseMessage, type Inline } from '../lib/message-format'

// Tints that read on both the grey and the outlined bubble, in either theme.
const CODE_BG = 'bg-black/10 dark:bg-white/10'

function renderInline(tokens: Inline[], keyPrefix: string): ReactNode[] {
  return tokens.map((tok, i) => {
    const key = `${keyPrefix}-${i}`

    switch (tok.t) {
      case 'text':
        return tok.v
      case 'code':
        return (
          <code key={key} className={`rounded px-1 py-0.5 font-mono text-[0.85em] ${CODE_BG}`}>
            {tok.v}
          </code>
        )
      case 'bold':
        return <strong key={key}>{renderInline(tok.c, key)}</strong>
      case 'italic':
        return <em key={key}>{renderInline(tok.c, key)}</em>
      case 'link':
        return (
          <a key={key} href={tok.href} target="_blank" rel="noopener noreferrer" className="underline break-all">
            {tok.href}
          </a>
        )
      default:
        return null
    }
  })
}

export default function MessageBody({ text }: { text: string }) {
  const blocks = parseMessage(text)

  return (
    <>
      {blocks.map((block, i) => {
        const gap = i === 0 ? '' : 'mt-1.5'

        if (block.t === 'code') {
          return (
            <pre key={i} className={`rounded-md px-2 py-1.5 font-mono text-xs whitespace-pre-wrap ${CODE_BG} ${gap}`}>
              {block.v}
            </pre>
          )
        }

        if (block.t === 'list') {
          return (
            <ul key={i} className={`list-disc pl-5 ${gap}`}>
              {block.items.map((item, j) => (
                <li key={j}>{renderInline(item, `${i}-${j}`)}</li>
              ))}
            </ul>
          )
        }

        return (
          <p key={i} className={`whitespace-pre-wrap ${gap}`}>
            {renderInline(block.c, String(i))}
          </p>
        )
      })}
    </>
  )
}
