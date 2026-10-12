'use strict';
const { DatabaseSync } = require('node:sqlite');

class DatabaseCompat {
  constructor(filePath) {
    this.db = new DatabaseSync(filePath);
    this.txDepth = 0;
  }

  pragma(sql) {
    try {
      this.db.exec(`PRAGMA ${sql};`);
    } catch (e) {
      // pragma errors ignored in memory/dev
    }
  }

  exec(sql) {
    return this.db.exec(sql);
  }

  close() {
    try {
      this.db.close();
    } catch (e) {}
  }

  prepare(sql) {
    const stmt = this.db.prepare(sql);
    return {
      get: (...args) => stmt.get(...args),
      all: (...args) => stmt.all(...args),
      run: (...args) => {
        const res = stmt.run(...args);
        return {
          changes: Number(res.changes || 0),
          lastInsertRowid: res.lastInsertRowid
        };
      }
    };
  }

  transaction(fn) {
    const self = this;
    return function (...args) {
      if (self.txDepth > 0) {
        return fn(...args);
      }
      self.txDepth++;
      self.db.exec('BEGIN');
      try {
        const res = fn(...args);
        self.db.exec('COMMIT');
        return res;
      } catch (err) {
        try {
          self.db.exec('ROLLBACK');
        } catch {}
        throw err;
      } finally {
        self.txDepth = Math.max(0, self.txDepth - 1);
      }
    };
  }
}

module.exports = DatabaseCompat;
