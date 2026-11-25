'use strict'

const assert = require('node:assert/strict')
const http = require('node:http')
const { test } = require('node:test')
const registerNodes = require('../iotdb')

function createRuntime() {
  const types = new Map()
  const configNodes = new Map()
  const RED = {
    nodes: {
      createNode(node, config) {
        node.credentials = config.credentials || {}
        node.handlers = {}
        node.statusValue = null
        node.on = (event, handler) => { node.handlers[event] = handler }
        node.status = status => { node.statusValue = status }
        node.send = message => { node.sent = message }
        node.error = error => { node.reportedError = error }
      },
      registerType(name, constructor, options) {
        types.set(name, { constructor, options })
      },
      getNode(id) {
        return configNodes.get(id)
      }
    }
  }

  registerNodes(RED)

  function config(overrides = {}) {
    const node = {}
    const definition = types.get('iotdb-config')
    definition.constructor.call(node, {
      host: '127.0.0.1',
      port: 18080,
      scheme: 'http',
      model: 'tree',
      username: 'root',
      credentials: { password: 'secret' },
      ...overrides
    })
    configNodes.set('server', node)
    return node
  }

  function queryNode(overrides = {}) {
    const node = {}
    types.get('iotdb-query').constructor.call(node, {
      server: 'server',
      database: '',
      sql: '',
      ...overrides
    })
    return node
  }

  return { types, config, queryNode }
}

async function withServer(handler, run) {
  const server = http.createServer((request, response) => {
    const chunks = []
    request.on('data', chunk => chunks.push(chunk))
    request.on('end', () => {
      handler(request, response, Buffer.concat(chunks).toString('utf8'))
    })
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  try {
    await run(server.address().port)
  } finally {
    server.closeAllConnections()
    await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
  }
}

function reply(response, value, status = 200) {
  response.writeHead(status, { 'Content-Type': 'application/json' })
  response.end(JSON.stringify(value))
}

function inject(node, message) {
  return new Promise(resolve => {
    node.handlers.input(message, output => resolve({ output }), error => resolve({ error }))
  })
}

test('registered query node writes and reads Tree and Table on a real IoTDB server', { skip: !process.env.IOTDB_TEST_URL }, async () => {
  const address = new URL(process.env.IOTDB_TEST_URL)
  const { randomUUID } = require('node:crypto')
  for (const model of ['tree', 'table']) {
    const runtime = createRuntime()
    runtime.config({ host: address.hostname, port: Number(address.port), scheme: address.protocol.slice(0, -1), model,
      username: process.env.IOTDB_TEST_USER, credentials: { password: process.env.IOTDB_TEST_PASSWORD } })
    const node = runtime.queryNode()
    const name = `nodered_${randomUUID().replace(/-/g, '')}`
    const db = model === 'tree' ? `root.${name}` : name
    async function send(sql, database = '') {
      const result = await inject(node, { payload: sql, iotdb: { database } })
      assert.ifError(result.error)
      return result.output.payload
    }
    await send(`CREATE DATABASE ${db}`)
    try {
      const source = model === 'tree' ? `${db}.meter` : 'meter'
      if (model === 'tree') await send(`CREATE TIMESERIES ${source}.v WITH DATATYPE=INT64,ENCODING=RLE`)
      else await send('CREATE TABLE meter(v INT64 FIELD)', db)
      await send(`INSERT INTO ${source}(time,v) VALUES(1735689600000,9007199254740993)`, db)
      const data = await send(`SELECT v FROM ${source} WHERE time=1735689600000 LIMIT 1`, db)
      assert.deepEqual(data.values, [['9007199254740993']])
    } finally {
      await send(model === 'tree' ? `DELETE DATABASE ${db}` : `DROP DATABASE ${db}`)
    }
  }
})

test('registers the IoTDB config and query nodes with encrypted password credentials', () => {
  const runtime = createRuntime()
  assert.ok(runtime.types.has('iotdb-config'))
  assert.ok(runtime.types.has('iotdb-query'))
  assert.deepEqual(runtime.types.get('iotdb-config').options.credentials, {
    password: { type: 'password' }
  })
})

test('sends Tree SQL to REST v2 and maps the response to msg.payload', async () => {
  const runtime = createRuntime()
  const calls = []
  await withServer((request, response, text) => {
    calls.push({ path: request.url, authorization: request.headers.authorization, body: JSON.parse(text) })
    reply(response, {
      expressions: ['root.site.temp'],
      data_types: ['DOUBLE'],
      timestamps: [1700000000000],
      values: [[21.5]]
    })
  }, async port => {
    runtime.config({ port })
    const node = runtime.queryNode()
    const message = { payload: 'SELECT temp FROM root.site' }
    const result = await inject(node, message)

    assert.equal(result.error, undefined)
    assert.equal(result.output, message)
    assert.deepEqual(message.payload.values, [[21.5]])
    assert.deepEqual(calls, [{
      path: '/rest/v2/query',
      authorization: 'Basic cm9vdDpzZWNyZXQ=',
      body: { sql: 'SELECT temp FROM root.site', row_limit: 1000 }
    }])
    assert.deepEqual(node.statusValue, { fill: 'green', shape: 'dot', text: 'ok' })
  })
})

test('sends Table mutations and message database overrides to Table REST', async () => {
  const runtime = createRuntime()
  let call
  await withServer((request, response, text) => {
    call = { path: request.url, body: JSON.parse(text) }
    reply(response, { code: 200, message: 'success' })
  }, async port => {
    runtime.config({ port, model: 'table' })
    const node = runtime.queryNode({ database: 'default_db' })
    const result = await inject(node, {
      payload: { sql: 'INSERT INTO readings(time, value) VALUES (1, 2.5)' },
      iotdb: { database: 'plant_a' }
    })

    assert.equal(result.error, undefined)
    assert.equal(call.path, '/rest/table/v1/nonQuery')
    assert.deepEqual(call.body, {
      sql: 'INSERT INTO readings(time, value) VALUES (1, 2.5)',
      database: 'plant_a'
    })
    assert.deepEqual(result.output.payload, { code: 200, message: 'success' })
  })
})

test('preserves IoTDB INT64 values outside JavaScript safe integer range', async () => {
  const runtime = createRuntime()
  await withServer((request, response) => {
    response.writeHead(200, { 'Content-Type': 'application/json' })
    response.end('{"code":200,"column_names":["value"],"values":[[9007199254740993]]}')
  }, async port => {
    runtime.config({ port, model: 'table' })
    const node = runtime.queryNode({ database: 'metrics' })
    const result = await inject(node, { payload: 'SELECT value FROM metrics' })
    assert.equal(result.error, undefined)
    assert.equal(result.output.payload.values[0][0], '9007199254740993')
  })
})

test('classifies commented metadata SQL and supports explicit action and configured SQL', async () => {
  const runtime = createRuntime()
  const calls = []
  await withServer((request, response, text) => {
    calls.push({ path: request.url, body: JSON.parse(text) })
    reply(response, { code: 200, column_names: ['Database'], values: [['root.factory']] })
  }, async port => {
    runtime.config({ port })
    const node = runtime.queryNode({ sql: 'DELETE FROM root.factory.device WHERE time < 1' })
    const first = await inject(node, { payload: '/* flow comment */ SHOW DATABASES' })
    const second = await inject(node, {
      payload: 'INSERT INTO root.factory.device(time, s1) VALUES (1, 2)',
      iotdb: { action: 'query' }
    })
    const third = await inject(node, { payload: '' })

    assert.equal(first.error, undefined)
    assert.equal(second.error, undefined)
    assert.equal(third.error, undefined)
    assert.deepEqual(calls.map(call => call.path), [
      '/rest/v2/query',
      '/rest/v2/query',
      '/rest/v2/nonQuery'
    ])
    assert.equal(calls[0].body.sql, '/* flow comment */ SHOW DATABASES')
    assert.equal(calls[2].body.sql, 'DELETE FROM root.factory.device WHERE time < 1')
  })
})

test('reports IoTDB status errors, invalid JSON, bad SQL, and request timeouts', async () => {
  const runtime = createRuntime()
  let mode = 'status'
  await withServer((request, response) => {
    if (mode === 'malformed') return response.writeHead(200).end('not-json')
    if (mode === 'timeout') return
    if (mode === 'http') return response.writeHead(401).end('unauthorized')
    reply(response, { code: 701, message: 'database is not specified' })
  }, async port => {
    runtime.config({ port, timeoutMs: 25 })
    const node = runtime.queryNode()
    const statusError = await inject(node, { payload: 'SHOW DATABASES' })
    mode = 'malformed'
    const jsonError = await inject(node, { payload: 'SHOW DATABASES' })
    mode = 'http'
    const httpError = await inject(node, { payload: 'SHOW DATABASES' })
    mode = 'timeout'
    const timeoutError = await inject(node, { payload: 'SHOW DATABASES' })
    const sqlError = await inject(node, { payload: '' })

    assert.match(statusError.error.message, /IoTDB 701: database is not specified/)
    assert.match(jsonError.error.message, /invalid JSON/)
    assert.match(httpError.error.message, /IoTDB HTTP 401/)
    assert.match(timeoutError.error.message, /timed out/)
    assert.match(sqlError.error.message, /SQL must be set/)
    assert.deepEqual(node.statusValue, { fill: 'red', shape: 'ring', text: 'error' })
  })
})

test('rejects invalid connection settings before making an HTTP request', async () => {
  const runtime = createRuntime()
  runtime.config({ host: 'bad host', port: 18080 })
  const node = runtime.queryNode()
  const result = await inject(node, { payload: 'SHOW DATABASES' })
  assert.match(result.error.message, /host must be a hostname or IP address/)
})
