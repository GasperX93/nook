import net from 'net'
import { logger } from './logger'

export const port = {
  value: -1,
}

const DEFAULT_PORT = 3054

export async function findFreePort() {
  const free = await testPort(DEFAULT_PORT)

  if (!free) {
    throw new Error(`Port ${DEFAULT_PORT} is already in use. Stop the other process and try again.`)
  }
  port.value = DEFAULT_PORT
  logger.info(`Using port ${DEFAULT_PORT}`)
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
