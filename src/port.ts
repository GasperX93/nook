import net from 'net'
import { logger } from './logger'

export const port = {
  value: -1,
}

const DEFAULT_PORT = 3000

export async function findFreePort() {
  const isDev = process.env.NODE_ENV === 'development'

  if (isDev) {
    const free = await testPort(DEFAULT_PORT)
    if (!free) {
      throw new Error(
        `Port ${DEFAULT_PORT} is already in use. Stop the other process and try again.`,
      )
    }
    port.value = DEFAULT_PORT
    logger.info(`Dev mode: using port ${DEFAULT_PORT}`)
    return
  }

  logger.info('Finding free port...')
  for (let i = DEFAULT_PORT; i < 5000; i++) {
    const free = await testPort(i)

    if (free) {
      port.value = i
      logger.info(`Found free port: ${i}`)

      return
    }
  }
}

async function testPort(port: number) {
  return new Promise(resolve => {
    const server = net.createServer()
    server.once('error', () => {
      server.close()
      resolve(false)
    })
    server.once('listening', () => {
      server.close()
      resolve(true)
    })
    server.listen(port)
  })
}
