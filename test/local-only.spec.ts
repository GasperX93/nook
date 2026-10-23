import { beeApiRefusal } from '../src/local-only'

// The /bee-api proxy is the whole Bee API with no key: only the dashboard on
// this computer (or a local program, which sends no Origin) may use it.

const dashboard = { host: 'localhost:3054', origin: 'http://localhost:3054', 'sec-fetch-site': 'same-origin' }

test('the dashboard and local programs may use it', () => {
  expect(beeApiRefusal(dashboard)).toBeNull()
  expect(beeApiRefusal({ host: '127.0.0.1:3054' })).toBeNull()
  expect(beeApiRefusal({ host: '[::1]:3054', 'sec-fetch-dest': 'empty' })).toBeNull()
})

test('another website is refused', () => {
  expect(beeApiRefusal({ ...dashboard, origin: 'https://evil.example' })).not.toBeNull()
  expect(beeApiRefusal({ ...dashboard, origin: 'null' })).not.toBeNull()
  expect(beeApiRefusal({ ...dashboard, origin: 'http://localhost:1633' })).not.toBeNull()
  expect(beeApiRefusal({ host: 'localhost:3054', 'sec-fetch-site': 'cross-site' })).not.toBeNull()
})

test('DNS rebinding (a foreign name pointing at this computer) is refused', () => {
  expect(beeApiRefusal({ host: 'evil.example:3054' })).not.toBeNull()
  expect(beeApiRefusal({ host: '192.168.1.20:3054' })).not.toBeNull()
  expect(beeApiRefusal({})).not.toBeNull()
})

test('Swarm content opened as a page on the dashboard address is refused', () => {
  expect(beeApiRefusal({ host: 'localhost:3054', 'sec-fetch-dest': 'document' })).not.toBeNull()
  expect(beeApiRefusal({ host: 'localhost:3054', 'sec-fetch-dest': 'iframe' })).not.toBeNull()
})
