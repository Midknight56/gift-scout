import { readFile } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'

export function deprecationIn(html) {
  return html.match(/planned deprecation|deprecated/i)?.[0] ?? null
}

async function checkModel() {
  const source = await readFile(new URL('../src/agent/model.ts', import.meta.url), 'utf8')
  const match = source.match(/MODEL\s*=\s*['"]([^'"]+)['"]/)
  if (!match) throw new Error('Could not read MODEL from src/agent/model.ts')
  const id = match[1]
  const name = id.slice(id.lastIndexOf('/') + 1)
  const url = `https://developers.cloudflare.com/workers-ai/models/${name}/`
  const response = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 (compatible; GiftScoutModelCheck/1.0)' } })
  if (!response.ok) throw new Error(`Model page fetch failed with HTTP ${response.status}: ${url}`)
  const html = await response.text()
  if (!html.toLowerCase().includes(id.toLowerCase())) throw new Error(`Model page does not name ${id}: ${url}`)
  const deprecation = deprecationIn(html)
  if (deprecation) throw new Error(`Configured model ${id} has a ${deprecation} notice: ${url}`)
  console.log(`model ok: ${id}`)
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  checkModel().catch((error) => {
    console.error(`model check failed: ${error instanceof Error ? error.message : String(error)}`)
    process.exitCode = 1
  })
}
