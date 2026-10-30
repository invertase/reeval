import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { test } from 'node:test'
import { type ChromeSession, withChrome } from '../src/capture/browser.ts'
import { probePage } from '../src/capture/page-state.ts'
import { pngSize } from '../src/capture/stub.ts'
import { shotRegion, shotScale } from '../src/capture/use.ts'

/** A Chrome on the PATH, as CI's runners have; the capture's own runs in the sandbox image. */
const chrome = ['google-chrome', 'chromium', 'chromium-browser'].find((bin) => {
  try {
    execFileSync(bin, ['--version'], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
})

const window = { width: 800, height: 600 }

const PAGES: Record<string, string> = {
  // 3000 px tall: a link at the bottom to /top, whose button sits at its top.
  '/tall': `<body style="margin:0"><div style="height:2900px"></div>
    <a id="next" href="/top" style="display:block;height:60px">Next page</a></body>`,
  '/top': `<body style="margin:0"><div style="height:3000px">
    <button id="go" style="height:60px;width:200px" onclick="document.title='clicked'">Go</button>
    </div></body>`,
  // A tall page whose rows each record a click.
  '/rows': `<body style="margin:0">${Array.from(
    { length: 40 },
    (_, i) =>
      `<button style="display:block;height:100px;width:100%" onclick="document.title='row ${i}'">Row ${i}</button>`,
  ).join('')}</body>`,
  '/frames': `<body><iframe id="same" src="/inner"></iframe>
    <iframe id="other" src="http://localhost:PORT/inner"></iframe>
    <news-letter id="closed"></news-letter>
    <script>customElements.define('news-letter', class extends HTMLElement {
      constructor() { super(); this.attachShadow({ mode: 'closed' }).innerHTML = '<input id="email">' }
    })</script></body>`,
  '/inner': `<body><input id="field" aria-label="Card"></body>`,
  '/when': `<body><input id="date" type="date"><input id="time" type="time"><input id="size" type="number"></body>`,
  '/when-frame': `<body><iframe id="when" src="/when"></iframe></body>`,
}

async function serve(): Promise<{ server: Server; origin: string }> {
  const server = createServer((req, res) => {
    const port = (server.address() as AddressInfo).port
    const page = PAGES[new URL(req.url ?? '/', 'http://x').pathname]
    res.writeHead(page ? 200 : 404, { 'content-type': 'text/html' })
    res.end(page?.replace('PORT', String(port)) ?? '')
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  return { server, origin: `http://127.0.0.1:${(server.address() as AddressInfo).port}` }
}

async function inChrome(fn: (session: ChromeSession, origin: string) => Promise<void>) {
  const { server, origin } = await serve()
  try {
    await withChrome(chrome as string, window, 30_000, {}, (session) => fn(session, origin))
  } finally {
    server.close()
  }
}

async function open(session: ChromeSession, url: string) {
  const nav = await session.navigate(url)
  await session.wait('load', 10_000, nav)
}

const title = async (session: ChromeSession) =>
  (
    (await session.cdp.send('Runtime.evaluate', { expression: 'document.title' })) as {
      result: { value: string }
    }
  ).result.value

const skip = chrome ? false : 'no Chrome or Chromium on the PATH'

test('a click after a navigation from a scrolled page lands, since the offset is read, not kept', {
  skip,
  timeout: 60_000,
}, async () => {
  await inChrome(async (session, origin) => {
    await open(session, `${origin}/tall`)
    const page = { width: 800, height: 2960 }
    const landed = await session.dispatch({ type: 'click', x: 100, y: 2930 }, page)
    assert.deepEqual(landed, { target: 'a "Next page"', scrolled: true })
    await session.wait('load', 10_000)
    await new Promise((resolve) => setTimeout(resolve, 300))
    // The new page starts at the top: the button at y 30 is in the window, not 2300 px above it.
    const go = await session.dispatch(
      { type: 'click', x: 100, y: 30 },
      { width: 800, height: 3000 },
    )
    assert.deepEqual(go, { target: 'button "Go"', scrolled: false })
    assert.equal(await title(session), 'clicked')
  })
})

test("a click on a point already in the window doesn't scroll, and a model's scroll past the end is clamped", {
  skip,
  timeout: 60_000,
}, async () => {
  await inChrome(async (session, origin) => {
    await open(session, `${origin}/rows`)
    const page = { width: 800, height: 4000 }
    await session.dispatch({ type: 'scroll', x: 400, y: 300, dy: 1000 }, page)
    await new Promise((resolve) => setTimeout(resolve, 200))
    assert.equal((await session.layout())?.scrollY, 1000)
    // Row 15 spans 1500-1600, in the window at 1000-1600: clicked where it is.
    const landed = await session.dispatch({ type: 'click', x: 400, y: 1550 }, page)
    assert.deepEqual(landed, { target: 'button "Row 15"', scrolled: false })
    assert.equal(await title(session), 'row 15')
    await session.dispatch({ type: 'scroll', x: 400, y: 1300, dy: 99_999 }, page)
    await new Promise((resolve) => setTimeout(resolve, 200))
    assert.equal((await session.layout())?.scrollY, 3400)
    // Row 39, at the bottom, after an overshooting scroll: still where the layout says.
    await session.dispatch({ type: 'click', x: 400, y: 3950 }, page)
    assert.equal(await title(session), 'row 39')
    // Row 2, above the window: scrolled to.
    const up = await session.dispatch({ type: 'click', x: 400, y: 250 }, page)
    assert.deepEqual(up, { target: 'button "Row 2"', scrolled: true })
    assert.equal(await title(session), 'row 2')
  })
})

test('the window shot of a tall page is the window at its offset, scaled as asked', {
  skip,
  timeout: 60_000,
}, async () => {
  await inChrome(async (session, origin) => {
    await open(session, `${origin}/rows`)
    await session.dispatch(
      { type: 'scroll', x: 400, y: 300, dy: 500 },
      { width: 800, height: 4000 },
    )
    await new Promise((resolve) => setTimeout(resolve, 200))
    const layout = await session.layout()
    assert.deepEqual(layout, { scrollY: 500, width: 800, height: 4000 })
    const { partial, ...region } = shotRegion(layout as NonNullable<typeof layout>, window)
    assert.equal(partial, true)
    const png = await session.screenshot(false, { x: 0, ...region, scale: 0.5 })
    assert.deepEqual(pngSize(png), { width: 400, height: 300 })
    // A page that fits in TALL_PAGE windows is shot whole, within the model's pixel budget.
    const whole = { x: 0, y: 0, width: 800, height: 1200, scale: shotScale(800, 1200) }
    const full = await session.screenshot(true, whole)
    assert.deepEqual(pngSize(full), { width: 800, height: 1200 })
  })
})

test("focus in a same-origin frame reads as the frame's field; a cross-origin frame or closed shadow root can't tell", {
  skip,
  timeout: 60_000,
}, async () => {
  await inChrome(async (session, origin) => {
    await open(session, `${origin}/frames`)
    await new Promise((resolve) => setTimeout(resolve, 500))
    const focus = (expression: string) => session.cdp.send('Runtime.evaluate', { expression })
    await focus(`document.getElementById('same').contentDocument.getElementById('field').focus()`)
    let state = await probePage(session)
    assert.equal(state.focus, 'input[text] "Card"')
    assert.equal(state.editable, true)
    await focus(`document.getElementById('other').focus()`)
    state = await probePage(session)
    assert.equal(state.editable, null)
    await focus(`document.getElementById('closed').focus(); document.activeElement.tagName`)
    // A closed root's input takes focus through its host.
    await session.dispatch({ type: 'click', x: 1, y: 1 })
    await focus(
      `(() => { const h = document.getElementById('closed'); h.tabIndex = 0; h.focus() })()`,
    )
    state = await probePage(session)
    assert.match(String(state.focus), /^news-letter/)
    assert.equal(state.editable, null)
  })
})

test('typing into a date or time field presses its keys, which its segments take', {
  skip,
  timeout: 60_000,
}, async () => {
  await inChrome(async (session, origin) => {
    await open(session, `${origin}/when`)
    const value = async (id: string, text: string) => {
      await session.cdp.send('Runtime.evaluate', {
        expression: `document.getElementById('${id}').focus()`,
      })
      await session.dispatch({ type: 'type', text })
      return (
        (await session.cdp.send('Runtime.evaluate', {
          expression: `document.getElementById('${id}').value`,
        })) as { result: { value: string } }
      ).result.value
    }
    assert.equal(await value('date', '11142026'), '2026-11-14')
    assert.equal(await value('time', '0730PM'), '19:30')
    assert.equal(await value('size', '4'), '4')
    await open(session, `${origin}/when-frame`)
    await new Promise((resolve) => setTimeout(resolve, 500))
    const field = `document.getElementById('when').contentDocument.getElementById('date')`
    await session.cdp.send('Runtime.evaluate', { expression: `${field}.focus()` })
    await session.dispatch({ type: 'type', text: '11142026' })
    const framed = (await session.cdp.send('Runtime.evaluate', {
      expression: `${field}.value`,
    })) as { result: { value: string } }
    assert.equal(framed.result.value, '2026-11-14')
  })
})
