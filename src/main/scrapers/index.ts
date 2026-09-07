import { BaseScraper } from './baseScraper'
import { ChatGPTScraper } from './chatgptScraper'
import { ClaudeScraper } from './claudeScraper'
import { KimiScraper } from './kimiScraper'
import { MiniMaxScraper } from './minimaxScraper'
import { RunwayMLScraper } from './runwaymlScraper'
import { FalAIScraper } from './falaiScraper'
import { OpenRouterScraper } from './openrouterScraper'
import { CursorScraper } from './cursorScraper'
import { GeminiScraper } from './geminiScraper'
import { HiggsfieldScraper } from './higgsfieldScraper'
import { GrokScraper } from './grokScraper'
import { QwenScraper } from './qwenScraper'

const scrapers: Record<string, BaseScraper> = {
  chatgpt: new ChatGPTScraper(),
  claude: new ClaudeScraper(),
  'kimi-code': new KimiScraper(),
  minimax: new MiniMaxScraper(),
  runwayml: new RunwayMLScraper(),
  'fal-ai': new FalAIScraper(),
  openrouter: new OpenRouterScraper(),
  cursor: new CursorScraper(),
  gemini: new GeminiScraper(),
  higgsfield: new HiggsfieldScraper(),
  grok: new GrokScraper(),
  qwen: new QwenScraper()
}

export function getScraper(serviceId: string): BaseScraper | undefined {
  return scrapers[serviceId]
}

export function getAllScrapers(): Record<string, BaseScraper> {
  return scrapers
}
