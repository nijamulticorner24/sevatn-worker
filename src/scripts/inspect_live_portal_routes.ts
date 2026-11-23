import { chromium } from 'playwright';

async function inspectLivePortal() {
  console.log('[INSPECT] Launching headless browser to inspect Sabarimala official portal...');
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  });
  const page = await context.newPage();

  try {
    console.log('[INSPECT] Navigating to https://sabarimalaonline.org/#/darshan...');
    await page.goto('https://sabarimalaonline.org/#/darshan', { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(3000);

    // Look for route dropdown
    const routeSelect = page.locator('select[name="route"], select[formcontrolname="route"], select#route, select').first();
    const isVisible = await routeSelect.isVisible({ timeout: 5000 }).catch(() => false);
    console.log('[INSPECT] Route select visible on #/darshan without auth:', isVisible);

    if (isVisible) {
      const options = await routeSelect.locator('option').evaluateAll((opts: HTMLOptionElement[]) => {
        return opts.map(o => ({ value: o.value, text: o.text.trim() }));
      });
      console.log('[INSPECT] Live Portal Route Options Captured:');
      console.table(options);
    } else {
      console.log('[INSPECT] Direct #/darshan may require authenticated state or redirected to #/home.');
      console.log('[INSPECT] Current URL:', page.url());
      // Inspect any route selectors in page HTML
      const html = await page.content();
      const selectMatches = html.match(/<select[^>]*route[^>]*>[\s\S]*?<\/select>/gi);
      if (selectMatches) {
        console.log('[INSPECT] Found select in HTML:', selectMatches);
      } else {
        console.log('[INSPECT] Portal Angular app redirected or rendered login boundary.');
      }
    }
  } catch (err: any) {
    console.error('[INSPECT] Error loading portal:', err.message);
  } finally {
    await browser.close();
  }
}

inspectLivePortal();
