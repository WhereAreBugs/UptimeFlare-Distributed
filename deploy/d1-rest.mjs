/** Operator-only adapter. Private SQL, parameters and remote errors never enter logs. */
export function createRestDatabase(endpoint, token, send = fetch) {
  const query = async (statements) => {
    const response = await send(endpoint, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(Array.isArray(statements) ? { batch: statements } : statements),
      signal: AbortSignal.timeout(60000),
      redirect: 'error',
    })
    const body = await response.json()
    if (
      !response.ok ||
      !body.success ||
      !Array.isArray(body.result) ||
      body.result.some((result) => !result.success)
    )
      throw Error('D1 migration query failed; private remote responses suppressed')
    return body.result
  }
  const prepare = (sql, params = []) => ({
    sql,
    params,
    bind(...values) {
      return prepare(sql, values)
    },
    async all() {
      return (await query({ sql, params }))[0]
    },
    async run() {
      return this.all()
    },
    async first(column) {
      const row = (await this.all()).results[0]
      return row ? (column === undefined ? row : row[column]) : null
    },
    async raw() {
      return (await this.all()).results.map((row) => Object.values(row))
    },
  })
  return {
    prepare,
    batch: (statements) => query(statements.map(({ sql, params }) => ({ sql, params }))),
  }
}
