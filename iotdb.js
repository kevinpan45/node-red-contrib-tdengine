'use strict'

const http = require('http')
const https = require('https')
const net = require('net')
const JSONBig = require('json-bigint')({ storeAsString: true })

const DEFAULT_TIMEOUT_MS = 15000
const DEFAULT_ROW_LIMIT = 1000
const MAX_RESPONSE_BYTES = 16 * 1024 * 1024
const QUERY_STATEMENT = /^(SELECT|WITH|SHOW|LIST|DESC|DESCRIBE|EXPLAIN)\b/i

function plainValue(value) {
  if (Array.isArray(value)) return value.map(plainValue)
  if (!value || typeof value !== 'object') return value
  const result = {}
  for (const [key, entry] of Object.entries(value)) {
    Object.defineProperty(result, key, {
      value: plainValue(entry),
      enumerable: true,
      configurable: true,
      writable: true
    })
  }
  return result
}

function normalizeSql(sql) {
  if (typeof sql !== 'string' || !sql.trim()) throw new Error('IoTDB SQL must be set.')
  return sql.trim()
}

function queryAction(sql) {
  let statement = sql.trimStart()
  while (statement) {
    if (statement.startsWith('--')) {
      const end = statement.search(/[\r\n]/)
      statement = end < 0 ? '' : statement.slice(end).trimStart()
    } else if (statement.startsWith('/*')) {
      const end = statement.indexOf('*/', 2)
      if (end < 0) break
      statement = statement.slice(end + 2).trimStart()
    } else {
      break
    }
  }
  return QUERY_STATEMENT.test(statement) ? 'query' : 'nonQuery'
}

class IoTDBClient {
  constructor(config) {
    const host = String(config.host || '').trim().replace(/^\[(.*)\]$/, '$1')
    const port = Number(config.port)
    const scheme = config.scheme || 'http'
    const timeout = Number(config.timeoutMs || DEFAULT_TIMEOUT_MS)
    const rowLimit = Number(config.rowLimit || DEFAULT_ROW_LIMIT)

    if (!host || (!net.isIP(host) && !/^[a-zA-Z0-9](?:[a-zA-Z0-9.-]*[a-zA-Z0-9])?$/.test(host))) {
      throw new Error('IoTDB host must be a hostname or IP address.')
    }
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('IoTDB port is invalid.')
    if (!['http', 'https'].includes(scheme)) throw new Error('IoTDB protocol must be http or https.')
    if (!Number.isInteger(timeout) || timeout < 1 || timeout > 300000) throw new Error('IoTDB timeout must be between 1 and 300000 ms.')
    if (!Number.isInteger(rowLimit) || rowLimit < 1 || rowLimit > 100000) throw new Error('IoTDB row limit must be between 1 and 100000.')

    this.host = host
    this.port = port
    this.scheme = scheme
    this.model = config.model || 'tree'
    if (!['tree', 'table'].includes(this.model)) throw new Error('IoTDB SQL model must be tree or table.')
    this.username = String(config.username || 'root')
    this.password = String(config.password || '')
    this.timeoutMs = timeout
    this.rowLimit = rowLimit
  }

  async execute(sql, database, action) {
    const statement = normalizeSql(sql)
    const selectedAction = action || queryAction(statement)
    if (!['query', 'nonQuery'].includes(selectedAction)) {
      throw new Error('IoTDB action must be query or nonQuery.')
    }

    const body = { sql: statement }
    if (this.model === 'table' && database) body.database = String(database)
    if (selectedAction === 'query') body.row_limit = this.rowLimit

    const path = this.model === 'tree'
      ? '/rest/v2/' + selectedAction
      : '/rest/table/v1/' + selectedAction
    const bytes = Buffer.from(JSON.stringify(body))
    const transport = this.scheme === 'https' ? https : http
    const authorization = 'Basic ' + Buffer.from(this.username + ':' + this.password).toString('base64')
    const response = await this.send(transport, path, bytes, authorization)

    if (!response || typeof response !== 'object' || Array.isArray(response)) {
      throw new Error('IoTDB returned an invalid response.')
    }
    if (response.code != null && Number(response.code) !== 200) {
      throw new Error('IoTDB ' + response.code + ': ' + (response.message || 'SQL execution failed.'))
    }
    const queryData = selectedAction === 'query' && Array.isArray(response.values) &&
      (Array.isArray(response.expressions) || Array.isArray(response.column_names))
    if (response.code == null && !queryData) throw new Error('IoTDB response did not include a status code.')
    return plainValue(response)
  }

  send(transport, path, body, authorization) {
    return new Promise((resolve, reject) => {
      let settled = false
      let totalBytes = 0
      const chunks = []
      let request
      const finish = (callback, value) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        callback(value)
      }
      const timer = setTimeout(() => {
        request.destroy(new Error('IoTDB request timed out.'))
      }, this.timeoutMs)

      request = transport.request({
        hostname: this.host,
        port: this.port,
        method: 'POST',
        path,
        headers: {
          Authorization: authorization,
          'Content-Type': 'application/json',
          'Content-Length': body.length
        }
      }, response => {
        response.on('error', error => finish(reject, error))
        response.on('data', chunk => {
          totalBytes += chunk.length
          if (totalBytes > MAX_RESPONSE_BYTES) {
            request.destroy(new Error('IoTDB response exceeded 16 MiB.'))
            return
          }
          chunks.push(chunk)
        })
        response.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8')
          let parsed
          try {
            parsed = text ? JSONBig.parse(text) : null
          } catch (_) {
            if (response.statusCode < 200 || response.statusCode >= 300) {
              return finish(reject, new Error('IoTDB HTTP ' + response.statusCode))
            }
            return finish(reject, new Error('IoTDB returned invalid JSON (HTTP ' + response.statusCode + ').'))
          }
          if (response.statusCode < 200 || response.statusCode >= 300) {
            const detail = parsed && parsed.message ? ': ' + parsed.message : ''
            return finish(reject, new Error('IoTDB HTTP ' + response.statusCode + detail))
          }
          finish(resolve, parsed)
        })
      })
      request.on('error', error => finish(reject, error))
      request.end(body)
    })
  }
}

module.exports = function (RED) {
  function IoTDBConfig(n) {
    RED.nodes.createNode(this, n)
    this.host = n.host
    this.port = n.port
    this.scheme = n.scheme || 'http'
    this.model = n.model || 'tree'
    this.username = n.username || 'root'
    this.password = (this.credentials && this.credentials.password) || n.password || ''
    this.timeoutMs = n.timeoutMs
    this.rowLimit = n.rowLimit
  }

  RED.nodes.registerType('iotdb-config', IoTDBConfig, {
    credentials: {
      password: { type: 'password' }
    }
  })

  function IoTDBQuery(n) {
    RED.nodes.createNode(this, n)
    this.server = RED.nodes.getNode(n.server)
    this.database = n.database || ''
    this.sql = n.sql || ''
    const node = this

    node.on('input', function (msg, send, done) {
      send = send || function () { node.send.apply(node, arguments) }
      const complete = typeof done === 'function'
        ? done
        : function (error) { if (error) node.error(error, msg) }

      ;(async function () {
        try {
          if (!node.server) throw new Error('IoTDB server configuration is not selected.')
          const payload = msg.payload
          const payloadSql = typeof payload === 'string'
            ? payload
            : payload && typeof payload === 'object' && typeof payload.sql === 'string'
              ? payload.sql
              : ''
          const sql = payloadSql || node.sql
          const inputOptions = msg.iotdb && typeof msg.iotdb === 'object' ? msg.iotdb : {}
          const database = inputOptions.database != null
            ? inputOptions.database
            : msg.database != null
              ? msg.database
              : node.database
          const action = inputOptions.action || ''
          const client = new IoTDBClient(node.server)

          node.status({ fill: 'blue', shape: 'dot', text: 'requesting' })
          msg.payload = await client.execute(sql, database, action)
          node.status({ fill: 'green', shape: 'dot', text: 'ok' })
          send(msg)
          complete()
        } catch (error) {
          node.status({ fill: 'red', shape: 'ring', text: 'error' })
          complete(error)
        }
      })()
    })
  }

  RED.nodes.registerType('iotdb-query', IoTDBQuery)
}

module.exports.IoTDBClient = IoTDBClient
module.exports.queryAction = queryAction
