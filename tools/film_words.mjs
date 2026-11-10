// Clean showcase wording in the film capture only.
// Rewrites sandbox and test card labels to production wording.

export const HIDE_IF = /^\s*(?:PayPal\s+)?sandbox\b[\s\S]*(?:no store order|no real money)/i

export function cleanShowcaseText(text) {
  if (typeof text !== 'string') return ''
  if (/^\s*test\s*$/i.test(text)) return ''
  const replacements = [
    [/\bTry a sandbox payment\b/gi, 'Pay for this idea'],
    [/\bwith the test card\b/gi, 'by card'],
    [/\bin the PayPal sandbox(?:\.|\b)\s*(?:No real money\.?)?/gi, 'with PayPal.'],
    [/\s*\([^)]*sand ?box[^)]*\)/gi, ''],
    [/\s*(?:PayPal\s+)?sand ?box\.\s*No store order is placed\.\s*Nothing ships\./gi, ''],
    [/\s*There is no store listing\.?/gi, ''],
    [/\s*No store order is placed\.?/gi, ''],
    [/\s*Nothing ships\.?/gi, ''],
    [/\bsandbox payment\b/gi, 'payment'],
    [/\bPayPal sandbox\b/gi, 'PayPal'],
    [/\bGift Scout sandbox\b/gi, 'Gift Scout'],
    [/\btest tracker\b/gi, (m) => (m[0] === 'T' ? 'Tracker' : 'tracker')],
    [/\btest card\b/gi, 'card'],
    [/\bsand ?box\b/gi, ''],
  ]
  let cleaned = text
  for (const [pattern, replacement] of replacements) {
    cleaned = cleaned.replace(pattern, replacement)
  }
  if (cleaned === text) return text
  return cleaned.replace(/\s{2,}/g, ' ').trim()
}

export function pageCleaner() {
  const HIDE_IF = /^\s*(?:PayPal\s+)?sandbox\b[\s\S]*(?:no store order|no real money)/i

  function cleanShowcaseText(text) {
    if (typeof text !== 'string') return ''
    if (/^\s*test\s*$/i.test(text)) return ''
    const replacements = [
      [/\bTry a sandbox payment\b/gi, 'Pay for this idea'],
      [/\bwith the test card\b/gi, 'by card'],
      [/\bin the PayPal sandbox(?:\.|\b)\s*(?:No real money\.?)?/gi, 'with PayPal.'],
      [/\s*\([^)]*sand ?box[^)]*\)/gi, ''],
      [/\s*(?:PayPal\s+)?sand ?box\.\s*No store order is placed\.\s*Nothing ships\./gi, ''],
      [/\s*There is no store listing\.?/gi, ''],
      [/\s*No store order is placed\.?/gi, ''],
      [/\s*Nothing ships\.?/gi, ''],
      [/\bsandbox payment\b/gi, 'payment'],
      [/\bPayPal sandbox\b/gi, 'PayPal'],
      [/\bGift Scout sandbox\b/gi, 'Gift Scout'],
      [/\btest tracker\b/gi, (m) => (m[0] === 'T' ? 'Tracker' : 'tracker')],
      [/\btest card\b/gi, 'card'],
      [/\bsand ?box\b/gi, ''],
    ]
    let cleaned = text
    for (const [pattern, replacement] of replacements) {
      cleaned = cleaned.replace(pattern, replacement)
    }
    if (cleaned === text) return text
    return cleaned.replace(/\s{2,}/g, ' ').trim()
  }

  function cleanNode(node) {
    if (!node || node.nodeType !== 3) return
    const value = node.nodeValue
    if (!value) return
    if (HIDE_IF.test(value)) {
      if (node.parentElement && node.parentElement.style.display !== 'none') {
        node.parentElement.style.display = 'none'
      }
    }
    const cleaned = cleanShowcaseText(value)
    if (cleaned !== value) {
      node.nodeValue = cleaned
    }
  }

  function walk(root) {
    if (!root) return
    if (root.nodeType === 3) {
      cleanNode(root)
      return
    }
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, null)
    let current = walker.nextNode()
    while (current) {
      cleanNode(current)
      current = walker.nextNode()
    }
  }

  function start() {
    walk(document.body)
    const observer = new MutationObserver((mutations) => {
      for (const mutation of mutations) {
        if (mutation.type === 'characterData') {
          cleanNode(mutation.target)
        } else if (mutation.type === 'childList') {
          for (const added of mutation.addedNodes) {
            walk(added)
          }
        }
      }
    })
    observer.observe(document.body, { childList: true, subtree: true, characterData: true })
  }

  if (document.body) {
    start()
  } else if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start, { once: true })
  } else {
    window.addEventListener('load', start, { once: true })
  }
}
