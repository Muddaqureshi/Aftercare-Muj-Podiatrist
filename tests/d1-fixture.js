import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";

export function testDatabase() {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec(readFileSync(new URL("../cloud/migrations/0001.sql", import.meta.url), "utf8"));
  const prepare = (sql, values = []) => ({
    bind(...bound) { return prepare(sql, bound); },
    async first() { return sqlite.prepare(sql).get(...values) || null; },
    async all() { return { results: sqlite.prepare(sql).all(...values) }; },
    async run() {
      const result = sqlite.prepare(sql).run(...values);
      return { success: true, meta: { changes: result.changes } };
    }
  });
  return {
    prepare,
    async batch(statements) {
      sqlite.exec("BEGIN");
      try {
        const results = [];
        for (const statement of statements) results.push(await statement.run());
        sqlite.exec("COMMIT");
        return results;
      } catch (error) { sqlite.exec("ROLLBACK"); throw error; }
    },
    close() { sqlite.close(); }
  };
}
