declare global {
  interface Window {
    logs: LogEntry[]
  }
}

export interface LogEntry {
  timestamp: string
  level: 'log' | 'warn' | 'error'
  component: string
  turnIndex?: number
  message: string
  data: Record<string, unknown>
}

if (typeof window !== 'undefined' && !window.logs) {
  window.logs = []
}

function formatTimestamp(): string {
  return new Date().toLocaleString()
}

function createLogEntry(
  level: 'log' | 'warn' | 'error',
  component: string,
  message: string,
  data: Record<string, unknown>,
  turnIndex?: number
): LogEntry {
  return {
    timestamp: formatTimestamp(),
    level,
    component,
    turnIndex,
    message,
    data,
  }
}

function formatPrefix(component: string, turnIndex?: number): string {
  const timestamp = formatTimestamp()
  const turnPart = turnIndex !== undefined ? ` [turn:${turnIndex}]` : ''
  return `[${component}] [${timestamp}]${turnPart}`
}

export function debugLog(
  component: string,
  message: string,
  data: Record<string, unknown> = {},
  turnIndex?: number
): void {
  const entry = createLogEntry('log', component, message, data, turnIndex)
  if (typeof window !== 'undefined') {
    window.logs.push(entry)
  }
  console.log(`${formatPrefix(component, turnIndex)} ${message}`, data)
}

export function debugWarn(
  component: string,
  message: string,
  data: Record<string, unknown> = {},
  turnIndex?: number
): void {
  const entry = createLogEntry('warn', component, message, data, turnIndex)
  if (typeof window !== 'undefined') {
    window.logs.push(entry)
  }
  console.warn(`${formatPrefix(component, turnIndex)} ${message}`, data)
}

export function debugError(
  component: string,
  message: string,
  data: Record<string, unknown> = {},
  turnIndex?: number
): void {
  const entry = createLogEntry('error', component, message, data, turnIndex)
  if (typeof window !== 'undefined') {
    window.logs.push(entry)
  }
  console.error(`${formatPrefix(component, turnIndex)} ${message}`, data)
}

export function getLogs(): LogEntry[] {
  return typeof window !== 'undefined' ? window.logs : []
}

export function clearLogs(): void {
  if (typeof window !== 'undefined') {
    window.logs = []
  }
}

export function getLogsByComponent(component: string): LogEntry[] {
  return getLogs().filter(log => log.component === component)
}

export function getLogsByTurn(turnIndex: number): LogEntry[] {
  return getLogs().filter(log => log.turnIndex === turnIndex)
}
