const puppeteer = require('puppeteer-core')
const path = require('path')

const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'
const URL = process.env.SHOT_URL || 'http://localhost:5173/'
const OUT = path.join(__dirname, process.env.SHOT_OUT || 'shot.png')

;(async () => {
  const browser = await puppeteer.launch({
    executablePath: EDGE,
    headless: true,
    args: ['--no-sandbox', '--force-device-scale-factor=1'],
    defaultViewport: { width: 1536, height: 1024 },
  })
  const page = await browser.newPage()
  const errors = []
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push('CONSOLE: ' + m.text())
  })
  page.on('pageerror', (e) => errors.push('PAGEERROR: ' + e.message))
  await page.goto(URL, { waitUntil: 'networkidle2', timeout: 60000 })
  await page.waitForSelector('.react-flow__node', { timeout: 20000 }).catch(() => {})
  await new Promise((r) => setTimeout(r, 2800))
  await page.screenshot({ path: OUT })
  console.log('SHOT:', OUT)
  console.log('ERRORS:', errors.length ? '\n' + errors.join('\n') : 'none')
  await browser.close()
})().catch((e) => {
  console.error('FATAL', e)
  process.exit(1)
})
