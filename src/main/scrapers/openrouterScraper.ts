import { BrowserWindow } from 'electron'
import { BaseScraper, ScrapedUsageData } from './baseScraper'

export class OpenRouterScraper extends BaseScraper {
    constructor() {
        super('openrouter', 'https://openrouter.ai/credits')
    }

    protected getExtraCookieDomains(): string[] {
        return ['openrouter.ai', '.openrouter.ai']
    }

    protected getLoginUrlPatterns(): string[] {
        return ['/login', '/signin', '/auth']
    }

    protected getPageReadyCheck(): string {
        return `document.readyState === 'complete' && document.body && document.body.innerText.length > 200`
    }

    protected async extractUsageData(win: BrowserWindow): Promise<ScrapedUsageData | null> {
        let url = win.webContents.getURL()
        console.log(`[openrouter] Current URL: ${url}`)

        if (this.isLoginUrl(url)) {
            console.log('[openrouter] On login page - login required')
            return { loginRequired: true } as any
        }

        // PASS 1: Get Balance from /credits
        let balance = 0
        let currentUsage = 0

        // Ensure we are on /credits 
        if (!url.includes('/credits')) {
            console.log('[openrouter] Navigating to /credits to get balance...')
            await win.loadURL('https://openrouter.ai/credits')
            await new Promise(r => setTimeout(r, 3000))
        }

        const creditsCode = `
            (() => {
                let topupSum = 0;
                let parsedBalance = 0;
                let balanceStrategy = null;

                // 1. Sum the transaction history table
                try {
                    const rows = document.querySelectorAll('tr');
                    for (const row of rows) {
                        const txt = row.innerText || '';
                        if (txt.includes('invoice') || /\\$\\s*[\\d,.]+/.test(txt)) {
                            const match = txt.match(/\\$\\s*([\\d,.]+)/);
                            if (match) {
                                const val = parseFloat(match[1].replace(/,/g, ''));
                                if (!isNaN(val) && val > 0 && !txt.toLowerCase().includes('amount')) {
                                    topupSum += val;
                                }
                            }
                        }
                    }
                } catch (e) { }

                const allEls = Array.from(document.querySelectorAll('*'));

                // Strategy A: lone element matching exactly "$ X.XX"
                try {
                    for (const el of allEls) {
                        const txt = el.innerText ? el.innerText.trim() : '';
                        if (/^\\$\\s*[\\d,.]+$/.test(txt)) {
                            const val = parseFloat(txt.replace(/[^\\d.]/g, ''));
                            if (!isNaN(val)) {
                                parsedBalance = val;
                                balanceStrategy = 'A: lone $X.XX';
                                break;
                            }
                        }
                    }
                } catch (e) {}

                // Strategy B: element labeled "Balance" / "Credits" / "Available" with nearby $ value
                if (!parsedBalance) {
                    try {
                        const labelRe = /^\\s*(balance|credits?\\s+remaining|credits?\\s+available|available\\s+credits?|account\\s+balance|remaining\\s+credits?)\\s*:?\\s*$/i;
                        for (const el of allEls) {
                            const txt = el.innerText ? el.innerText.trim() : '';
                            if (!labelRe.test(txt)) continue;
                            const sibling = el.nextElementSibling;
                            const candidates = [sibling?.innerText, el.parentElement?.innerText].filter(Boolean);
                            for (const cand of candidates) {
                                const m = cand.match(/\\$\\s*([\\d,.]+)/);
                                if (m) {
                                    const val = parseFloat(m[1].replace(/,/g, ''));
                                    if (!isNaN(val)) {
                                        parsedBalance = val;
                                        balanceStrategy = 'B: labeled+sibling';
                                        break;
                                    }
                                }
                            }
                            if (parsedBalance) break;
                        }
                    } catch (e) {}
                }

                // Strategy C: scan body text for "Balance ... $X.XX" or "$X.XX credits remaining"
                if (!parsedBalance) {
                    try {
                        const body = document.body ? document.body.innerText : '';
                        const patterns = [
                            /(?:^|\\n)\\s*Balance[\\s\\S]{0,40}?\\$\\s*([\\d,.]+)/i,
                            /\\$\\s*([\\d,.]+)\\s*(?:credits?\\s+(?:remaining|available|left)|in\\s+credits?)/i,
                            /(?:Available|Remaining)\\s+credits?[\\s\\S]{0,40}?\\$\\s*([\\d,.]+)/i,
                            /Credits?\\s+(?:remaining|available)[\\s\\S]{0,40}?\\$\\s*([\\d,.]+)/i
                        ];
                        for (const re of patterns) {
                            const m = body.match(re);
                            if (m) {
                                const val = parseFloat(m[1].replace(/,/g, ''));
                                if (!isNaN(val)) {
                                    parsedBalance = val;
                                    balanceStrategy = 'C: body regex';
                                    break;
                                }
                            }
                        }
                    } catch (e) {}
                }

                return { topupSum, parsedBalance, balanceStrategy };
            })()
        `;

        const creditsData = await win.webContents.executeJavaScript(creditsCode);

        let limitFromHistory = 0;
        if (creditsData) {
            if (creditsData.parsedBalance) {
                balance = creditsData.parsedBalance;
                console.log(`[openrouter] Found balance: $${balance} (strategy ${creditsData.balanceStrategy})`);
            } else {
                console.log(`[openrouter] Balance lookup failed — no strategy matched`);
            }
            if (creditsData.topupSum) {
                limitFromHistory = creditsData.topupSum;
                console.log(`[openrouter] Found limit from top-ups: $${limitFromHistory}`);
            }
        }

        // PASS 2: Get Activity from /activity
        console.log('[openrouter] Navigating to /activity to get sub-models...')
        await win.loadURL('https://openrouter.ai/activity')

        // Wait for the activity data to load (bar charts and lists)
        await new Promise(r => setTimeout(r, 4000))

        // Fetch page text plus the currently selected stats period (day/week/month).
        // The /activity Spend/Requests/Tokens sections all reflect the selected
        // period, so per-model token sub-models must be labelled with it (or
        // skipped when the period can't be determined — never guessed).
        const activityRaw = await win.webContents.executeJavaScript(`
            (() => {
                const text = document.body ? document.body.innerText : '';
                let period = null;
                const candidates = Array.from(document.querySelectorAll('button, [role="tab"], [aria-pressed], [aria-selected], [data-state], a'));
                for (const el of candidates) {
                    const label = (el.textContent || '').trim().toLowerCase();
                    if (label !== 'day' && label !== 'week' && label !== 'month') continue;
                    const pressed =
                        el.getAttribute('aria-pressed') === 'true' ||
                        el.getAttribute('aria-selected') === 'true' ||
                        el.getAttribute('data-state') === 'active' ||
                        /\\b(active|selected)\\b/i.test(el.className || '');
                    if (pressed) { period = label; break; }
                }
                return JSON.stringify({ text, period });
            })()
        `)

        let activityText = ''
        let activityPeriod: string | null = null
        try {
            const parsedActivity = JSON.parse(activityRaw || '{}')
            activityText = typeof parsedActivity.text === 'string' ? parsedActivity.text : ''
            activityPeriod = parsedActivity.period === 'day' || parsedActivity.period === 'week' || parsedActivity.period === 'month'
                ? parsedActivity.period
                : null
        } catch {
            activityText = typeof activityRaw === 'string' ? activityRaw : ''
        }
        console.log(`[openrouter] Activity period: ${activityPeriod ?? 'undetectable'}`)

        const lowerActivity = activityText.toLowerCase()
        if (
            /sign in|log in|continue with|create account/.test(lowerActivity) &&
            !/spend|credits|activity|api keys/.test(lowerActivity)
        ) {
            console.log('[openrouter] Activity page looks signed out - login required')
            this.setLastFailureReason('login_required')
            return { loginRequired: true } as any
        }

        // Look for Spend $X.XX
        const spendMatch = activityText.match(/Spend[\s\n]*\$\s*([\d,.]+)/i)
        if (spendMatch) {
            currentUsage = parseFloat(spendMatch[1].replace(/,/g, ''))
            console.log(`[openrouter] Found spend: $${currentUsage}`)
        }

        // Look for submodels
        const subModels: any[] = []

        // Parse a human token count like "1.2M", "45.3K", "12,345" or "678".
        const parseTokenCount = (raw: string): number | null => {
            const m = raw.trim().match(/^([\d,.]+)\s*([KMB])?$/i)
            if (!m) return null
            const base = parseFloat(m[1].replace(/,/g, ''))
            if (!isNaN(base) && base >= 0) {
                const mult = m[2] ? (m[2].toUpperCase() === 'K' ? 1_000 : m[2].toUpperCase() === 'M' ? 1_000_000 : 1_000_000_000) : 1
                return Math.round(base * mult)
            }
            return null
        }

        try {
            // Split by lines
            const lines = activityText.split('\n').map((l: string) => l.trim()).filter((l: string) => l.length > 0)

            // The /activity page stacks three sections: Spend ($), Requests, Tokens.
            // Track which section we are in instead of stopping at Requests/Tokens.
            let section: 'spend' | 'requests' | 'tokens' | null = null
            let currentModelName = ''

            for (let i = 0; i < lines.length; i++) {
                const line = lines[i]
                const lowerLine = line.toLowerCase()

                if (lowerLine === 'spend') { section = 'spend'; currentModelName = ''; continue }
                if (lowerLine === 'requests') { section = 'requests'; currentModelName = ''; continue }
                if (lowerLine === 'tokens') { section = 'tokens'; currentModelName = ''; continue }

                if (section === 'spend') {
                    // Skip the totals line like "$6.89"
                    if (/^\$[\d,.]+$/.test(line)) continue

                    // Check if it's on one line: "• MiniMax M2.5     6.75"
                    const match = line.match(/^[•\-\*]?\s*(.+?)\s+([\d.]+)$/)
                    if (match) {
                        const name = match[1].trim()
                        const cost = parseFloat(match[2])
                        if (name.toLowerCase() !== 'others' && !name.toLowerCase().includes('others')) {
                            subModels.push({
                                name: name,
                                count: cost,
                                total: currentUsage > 0 ? currentUsage : 1
                            })
                        }
                    } else {
                        // Multi-line fallback: Line 1 = "• Model", Line 2 = "6.75"
                        if (/^[\d.]+$/.test(line)) {
                            if (currentModelName && currentModelName.toLowerCase() !== 'others' && !currentModelName.toLowerCase().includes('others')) {
                                subModels.push({
                                    name: currentModelName,
                                    count: parseFloat(line),
                                    total: currentUsage > 0 ? currentUsage : 1
                                })
                            }
                            currentModelName = ''
                        } else {
                            currentModelName = line.replace(/^[•\-\*]\s*/, '').trim()
                        }
                    }
                } else if (section === 'tokens' && activityPeriod) {
                    // Per-model token rows, same one-line / two-line shapes as Spend.
                    // Values may carry K/M/B suffixes. Label carries the selected
                    // period so the UI doesn't present e.g. daily tokens as monthly.
                    const match = line.match(/^[•\-\*]?\s*(.+?)\s+([\d,.]+\s*[KMB]?)$/i)
                    if (match) {
                        const name = match[1].trim()
                        const tokens = parseTokenCount(match[2])
                        if (tokens !== null && name.toLowerCase() !== 'others' && !name.toLowerCase().includes('others') && !/^\d/.test(name)) {
                            subModels.push({
                                name: `${name} · tokens (${activityPeriod})`,
                                count: tokens
                            })
                        }
                        currentModelName = ''
                        continue
                    }
                    // Multi-line fallback: Line 1 = "• Model", Line 2 = "1.2M"
                    const tokenVal = parseTokenCount(line)
                    if (tokenVal !== null && !line.includes('$')) {
                        if (currentModelName && currentModelName.toLowerCase() !== 'others' && !currentModelName.toLowerCase().includes('others')) {
                            subModels.push({
                                name: `${currentModelName} · tokens (${activityPeriod})`,
                                count: tokenVal
                            })
                        }
                        currentModelName = ''
                    } else {
                        currentModelName = line.replace(/^[•\-\*]\s*/, '').trim()
                    }
                }
                // section === 'requests': counted rows we don't surface; skip.
            }

            if (!activityPeriod) {
                console.log('[openrouter] Tokens section skipped — selected period (day/week/month) undetectable')
            }
        } catch (e) {
            console.error('[openrouter] Error parsing submodels', e)
        }

        // Limit is Usage + Balance so the progress bar works
        // Alternatively, if we extracted Topups history, use that exactly.
        const usageLimit = limitFromHistory > 0 ? limitFromHistory : (currentUsage + balance);

        return {
            currentUsage: currentUsage,
            usageLimit: usageLimit,
            percentUsed: usageLimit > 0 ? Math.round((currentUsage / usageLimit) * 100) : 0,
            usageUnit: '$ spend',
            resetsAt: null,
            weeklyUsage: null,
            weeklyLimit: null,
            weeklyPercentUsed: null,
            subModels: subModels.length > 0 ? subModels : undefined
        }
    }
}
