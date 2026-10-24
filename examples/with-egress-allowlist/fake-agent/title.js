const html = await (await fetch('https://example.com')).text()
console.log(html.match(/<title>(.*?)<\/title>/)[1])
